/**
 * Sales channels the owner manages (D60): GrabFood, foodpanda, Walk-in and any number of their
 * own (Lalamove, ShopeeFood, Facebook, phone orders).
 *
 *   GET   /sales-channels                 any signed-in user (the New Order screen lists them)
 *   POST  /sales-channels                 OWNER: add a manual channel (client_request_id)
 *   PATCH /sales-channels/:id             OWNER: name, colour, default rates, active
 *   POST  /sales-channels/:id/listings    OWNER: offer a manual channel at every brand's outlets
 *
 * Owner-made channels are always MANUAL: a partner API integration is code, so GrabFood and
 * foodpanda are the only API channels and exist in every workspace (system codes). Duplicate
 * safety: create replays by client_request_id; PATCH sets absolute values; offering listings is
 * an insert-if-missing keyed on a deterministic listing id, so repeating it adds nothing.
 */
import { Router, type Request } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { toRows } from "../../db/rows.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import { salesChannels } from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_UNIQUE = "sales_channel_name_unique";
const REQUEST_UNIQUE = "sales_channel_request_unique";

const rate = z.number().min(0).max(100).nullable();
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB");

const createSchema = z
  .object({
    client_request_id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    color: color.optional(),
    default_commission_rate: rate.optional(),
    default_marketing_rate: rate.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: color.optional(),
    default_commission_rate: rate.optional(),
    default_marketing_rate: rate.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const offerSchema = z.object({ brand_ids: z.array(z.string().uuid()).max(200).optional() }).strict();

function actorOf(req: Request) {
  return { actorUserId: req.user!.id, actorName: req.user!.name ?? null, sessionId: req.user!.sessionId ?? null };
}

function serialize(row: typeof salesChannels.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    integration: row.integration,
    color: row.color,
    defaultCommissionRate: row.defaultCommissionRate === null ? null : Number(row.defaultCommissionRate),
    defaultMarketingRate: row.defaultMarketingRate === null ? null : Number(row.defaultMarketingRate),
    isActive: row.isActive,
    isSystem: row.code !== null,
    createdAt: row.createdAt,
  };
}

/** Makes sure this workspace has GrabFood, foodpanda and Walk-in (idempotent, migration 0054). */
export async function ensureSystemChannels(db: DB): Promise<void> {
  await db.execute(
    sql`SELECT ensure_system_sales_channels(coalesce(current_tenant_id(), '00000000-0000-4000-8000-000000000001'::uuid))`,
  );
}

export function createChannelsRouter(db: DB): Router {
  const router = Router();

  router.get("/sales-channels", requireAuth, async (req, res) => {
    await ensureSystemChannels(db);
    const activeOnly = req.query.active === "true";
    const rows = await db
      .select()
      .from(salesChannels)
      .where(activeOnly ? eq(salesChannels.isActive, true) : undefined)
      // System channels first (GrabFood, foodpanda, Walk-in), then the owner's own by name.
      .orderBy(sql`${salesChannels.code} IS NULL`, asc(salesChannels.name));
    res.json(rows.map(serialize));
  });

  router.post("/sales-channels", requireAuth, requireRole("OWNER"), async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid sales channel.", parsed.error.issues);
      return;
    }
    const body = parsed.data;
    const replay = async () => {
      const [existing] = await db.select().from(salesChannels).where(eq(salesChannels.clientRequestId, body.client_request_id));
      return existing ?? null;
    };
    const prior = await replay();
    if (prior) {
      res.status(200).json(serialize(prior));
      return;
    }
    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(salesChannels)
          .values({
            name: body.name,
            integration: "MANUAL",
            color: body.color ?? "#64748B",
            defaultCommissionRate: body.default_commission_rate == null ? null : String(body.default_commission_rate),
            defaultMarketingRate: body.default_marketing_rate == null ? null : String(body.default_marketing_rate),
            clientRequestId: body.client_request_id,
          })
          .returning();
        await audit(tx as unknown as DB, {
          ...actorOf(req),
          action: "sales_channel.create",
          description: `Added sales channel ${row!.name}`,
          entityType: "sales_channel",
          entityId: row!.id,
        });
        return row!;
      });
      res.status(201).json(serialize(created));
    } catch (err) {
      if (isUniqueViolation(err, REQUEST_UNIQUE)) {
        const twin = await replay();
        if (twin) {
          res.status(200).json(serialize(twin));
          return;
        }
      }
      if (isUniqueViolation(err, NAME_UNIQUE)) {
        sendError(res, 409, "NAME_TAKEN", `A channel named "${body.name}" already exists.`);
        return;
      }
      throw err;
    }
  });

  router.patch("/sales-channels/:id", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      sendError(res, 404, "NOT_FOUND", "Sales channel not found.");
      return;
    }
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid sales channel change.", parsed.error.issues);
      return;
    }
    const body = parsed.data;
    const [existing] = await db.select().from(salesChannels).where(eq(salesChannels.id, id));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Sales channel not found.");
      return;
    }
    // The counter's walk-in orders always land on this channel; switching it off would make
    // every walk-in sale fail.
    if (existing.code === "WALK_IN" && body.is_active === false) {
      sendError(res, 409, "CHANNEL_REQUIRED", "Walk-in / Direct cannot be switched off: counter sales use it.");
      return;
    }
    const updates: Partial<typeof salesChannels.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.color !== undefined) updates.color = body.color;
    if (body.default_commission_rate !== undefined) updates.defaultCommissionRate = body.default_commission_rate === null ? null : String(body.default_commission_rate);
    if (body.default_marketing_rate !== undefined) updates.defaultMarketingRate = body.default_marketing_rate === null ? null : String(body.default_marketing_rate);
    if (body.is_active !== undefined) updates.isActive = body.is_active;
    try {
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(salesChannels).set(updates).where(eq(salesChannels.id, id)).returning();
        await audit(tx as unknown as DB, {
          ...actorOf(req),
          action: "sales_channel.update",
          description: `Updated sales channel ${row!.name}: ${Object.keys(body).join(", ")}`,
          entityType: "sales_channel",
          entityId: id,
          metadata: { fields: Object.keys(body) },
        });
        return row!;
      });
      res.json(serialize(updated));
    } catch (err) {
      if (isUniqueViolation(err, NAME_UNIQUE)) {
        sendError(res, 409, "NAME_TAKEN", `A channel named "${body.name}" already exists.`);
        return;
      }
      throw err;
    }
  });

  // Offer a manual channel wherever the brands operate: one listing per active brand
  // deployment (brand x outlet) that does not have one yet. The listing id is derived from
  // (channel, brand, outlet), so the existing active-listing unique index makes a repeat (or a
  // double click) insert nothing.
  router.post("/sales-channels/:id/listings", requireAuth, requireRole("OWNER"), async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      sendError(res, 404, "NOT_FOUND", "Sales channel not found.");
      return;
    }
    const parsed = offerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Send { brand_ids? }.", parsed.error.issues);
      return;
    }
    const [channel] = await db.select().from(salesChannels).where(eq(salesChannels.id, id));
    if (!channel) {
      sendError(res, 404, "NOT_FOUND", "Sales channel not found.");
      return;
    }
    if (channel.integration !== "MANUAL") {
      sendError(res, 409, "API_CHANNEL", `${channel.name} listings come from the partner (store IDs); add them under Channel Listings.`);
      return;
    }
    if (!channel.isActive) {
      sendError(res, 409, "CHANNEL_INACTIVE", `${channel.name} is switched off.`);
      return;
    }
    const brandIds = parsed.data.brand_ids;
    const brandFilter = brandIds
      ? brandIds.length === 0
        ? sql`AND FALSE`
        : sql`AND bo.brand_id IN (${sql.join(brandIds.map((b) => sql`${b}::uuid`), sql`, `)})`
      : sql``;

    const result = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO aggregator_account (brand_id, location_id, aggregator, channel_id, external_merchant_id, credential_ref, mapping_status, commission_rate)
        SELECT bo.brand_id, bo.location_id, 'OTHER', ${channel.id}::uuid,
               'CH-' || ${channel.id} || '-' || bo.brand_id || '-' || bo.location_id, 'manual', 'RESOLVED', ${channel.defaultCommissionRate}
        FROM brand_outlet bo
        JOIN brand b ON b.id = bo.brand_id
        WHERE bo.is_active AND b.is_active ${brandFilter}
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const created = toRows<{ id: string }>(inserted).length;
      if (created > 0) {
        await audit(tx as unknown as DB, {
          ...actorOf(req),
          action: "sales_channel.offer",
          description: `Offered ${channel.name} at ${created} brand outlet(s)`,
          entityType: "sales_channel",
          entityId: channel.id,
          metadata: { created },
        });
      }
      return created;
    });
    const [{ total }] = toRows<{ total: string }>(
      await db.execute(sql`SELECT count(*)::text AS total FROM aggregator_account WHERE channel_id = ${channel.id}::uuid AND is_active`),
    ) as [{ total: string }];
    res.json({ channelId: channel.id, created: result, activeListings: Number(total) });
  });

  return router;
}

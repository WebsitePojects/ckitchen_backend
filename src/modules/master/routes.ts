/**
 * Master-data Routes — ERP R2 (CK1-ERP-006 §1-2)
 *
 * Suppliers, Customers, and Department↔Warehouse access permissions.
 * Reads require auth; writes require SUPER_ADMIN. Every mutation is audited.
 * `code` is normalized to UPPERCASE and unique-checked (409 on duplicate).
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import {
  customers,
  departmentEnum,
  departmentInventoryAccess,
  suppliers,
  warehouseTypeEnum,
} from "../../db/schema.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { paramAsString, sendError } from "../http-errors.js";
import { audit } from "../ems/audit.js";

const WRITE_ROLES = ["OWNER"] as const;

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// Suppliers and customers share an identical contact/term shape.
const partyCreateSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  payment_term_days: z.number().int().min(0).optional(),
});

const partyUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    contact_name: z.string().nullable().optional(),
    contact_phone: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    address: z.string().nullable().optional(),
    payment_term_days: z.number().int().min(0).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

const deptAccessUpsertSchema = z.object({
  department: z.enum(departmentEnum.enumValues),
  warehouse_type: z.enum(warehouseTypeEnum.enumValues),
  can_view: z.boolean().optional(),
  can_view_cost: z.boolean().optional(),
  can_receive: z.boolean().optional(),
  can_issue: z.boolean().optional(),
  can_adjust: z.boolean().optional(),
  can_approve: z.boolean().optional(),
});

export function createMasterRouter(db: DB): Router {
  const router = Router();

  // Generic CRUD for the supplier/customer party tables (identical shape).
  function registerParty(
    table: typeof suppliers | typeof customers,
    path: string,
    entityType: string,
  ) {
    router.get(`/${path}`, requireAuth, async (req, res) => {
      const activeParam = req.query.active as string | undefined;
      const rows = await db.select().from(table);
      const filtered =
        activeParam === "true"
          ? rows.filter((r) => r.isActive)
          : activeParam === "false"
            ? rows.filter((r) => !r.isActive)
            : rows;
      res.json(filtered);
    });

    router.post(`/${path}`, requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
      const parsed = partyCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", `Invalid ${entityType} payload.`, parsed.error.issues);
        return;
      }
      const code = normalizeCode(parsed.data.code);
      const [dup] = await db.select().from(table).where(eq(table.code, code));
      if (dup) {
        sendError(res, 409, "CONFLICT", `${entityType} code ${code} already exists.`);
        return;
      }
      const [created] = await db
        .insert(table)
        .values({
          code,
          name: parsed.data.name,
          contactName: parsed.data.contact_name ?? null,
          contactPhone: parsed.data.contact_phone ?? null,
          email: parsed.data.email ?? null,
          address: parsed.data.address ?? null,
          paymentTermDays: parsed.data.payment_term_days ?? 0,
        })
        .returning();

      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: `${entityType}.create`,
        description: `Created ${entityType} ${code} — ${parsed.data.name}`,
        entityType,
        entityId: created!.id,
      });
      res.status(201).json(created);
    });

    router.patch(`/${path}/:id`, requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
      const parsed = partyUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", `Invalid ${entityType} payload.`, parsed.error.issues);
        return;
      }
      const id = paramAsString(req.params.id);
      const [existing] = await db.select().from(table).where(eq(table.id, id));
      if (!existing) {
        sendError(res, 404, "NOT_FOUND", `${entityType} not found.`);
        return;
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.contact_name !== undefined) updates.contactName = parsed.data.contact_name;
      if (parsed.data.contact_phone !== undefined) updates.contactPhone = parsed.data.contact_phone;
      if (parsed.data.email !== undefined) updates.email = parsed.data.email;
      if (parsed.data.address !== undefined) updates.address = parsed.data.address;
      if (parsed.data.payment_term_days !== undefined) updates.paymentTermDays = parsed.data.payment_term_days;
      if (parsed.data.is_active !== undefined) updates.isActive = parsed.data.is_active;

      const [updated] = await db.update(table).set(updates).where(eq(table.id, id)).returning();

      void audit(db, {
        actorUserId: req.user!.id,
        actorName: req.user!.name ?? null,
        sessionId: req.user!.sessionId ?? null,
        action: `${entityType}.update`,
        description: `Updated ${entityType} ${existing.code}`,
        entityType,
        entityId: id,
      });
      res.json(updated);
    });
  }

  registerParty(suppliers, "suppliers", "supplier");
  registerParty(customers, "customers", "customer");

  // ── Department ↔ Warehouse access ─────────────────────────────────────────
  router.get("/department-access", requireAuth, async (_req, res) => {
    const rows = await db.select().from(departmentInventoryAccess);
    res.json(rows);
  });

  // Upsert one (department, warehouse_type) permission row.
  router.put("/department-access", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = deptAccessUpsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid department-access payload.", parsed.error.issues);
      return;
    }
    const d = parsed.data;
    // (department, warehouse_type) is unique — find the existing row to upsert.
    const target = (
      await db
        .select()
        .from(departmentInventoryAccess)
        .where(eq(departmentInventoryAccess.department, d.department))
    ).find((r) => r.warehouseType === d.warehouse_type);

    const values = {
      department: d.department,
      warehouseType: d.warehouse_type,
      canView: d.can_view ?? true,
      canViewCost: d.can_view_cost ?? false,
      canReceive: d.can_receive ?? false,
      canIssue: d.can_issue ?? false,
      canAdjust: d.can_adjust ?? false,
      canApprove: d.can_approve ?? false,
      updatedAt: new Date(),
    };

    let row;
    if (target) {
      [row] = await db
        .update(departmentInventoryAccess)
        .set(values)
        .where(eq(departmentInventoryAccess.id, target.id))
        .returning();
    } else {
      [row] = await db.insert(departmentInventoryAccess).values(values).returning();
    }

    void audit(db, {
      actorUserId: req.user!.id,
      actorName: req.user!.name ?? null,
      sessionId: req.user!.sessionId ?? null,
      action: "department_access.upsert",
      description: `Set ${d.department} access on ${d.warehouse_type} warehouse`,
      entityType: "department_inventory_access",
      entityId: row!.id,
    });
    res.json(row);
  });

  return router;
}

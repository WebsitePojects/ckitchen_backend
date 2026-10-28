/**
 * Self-serve sign-up: a signed-in Google account creates its own workspace (D53, D55).
 *
 * One transaction on the owner connection:
 *   1. the workspace (tenant + settings) and its database role ws_<id>;
 *   2. SET LOCAL ROLE to that role, so every following row is written AS the new workspace
 *      (row-level security + the tenant_id default put it there; nothing can land elsewhere);
 *   3. the owner's account (linked to Clerk; the membership trigger records the workspace),
 *      the first outlet with its MAIN and KITCHEN warehouses and one kitchen station, the
 *      first brand deployed there, and the default role -> page access matrix.
 * Any failure rolls all of it back, role included (CREATE ROLE is transactional).
 *
 * One workspace per Google account for now: an account already in ORION is refused, and the
 * same person retrying (double click, timeout) gets their existing workspace back.
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DB } from "../../db/client.js";
import { brandOutlet, brands, kitchenStations, locations, memberships, tenants, tenantSettings, users, warehouses } from "../../db/schema.js";
import { hashPassword } from "../auth/service.js";
import { seedRolePageAccess } from "../admin/routes.js";
import { audit } from "../ems/audit.js";
import { actAsWorkspace } from "../tenancy/roles.js";

export interface SignupInput {
  businessName: string;
  ownerName: string;
  outletName: string;
  brandName: string;
  brandColor: string;
}

export interface CreatedWorkspace {
  id: string;
  slug: string;
  name: string;
}

export type SignupResult =
  | { ok: true; workspace: CreatedWorkspace; replay: boolean }
  | { ok: false; code: "EMAIL_NOT_VERIFIED" | "EMAIL_ALREADY_ADDED" | "ALREADY_MEMBER"; email?: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** URL key from the business name plus a short random suffix (names repeat; slugs cannot). */
export function workspaceSlug(businessName: string, suffix = randomBytes(3).toString("hex")): string {
  const base = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  const slug = `${base.length >= 2 ? base : "workspace"}-${suffix}`;
  if (!SLUG_RE.test(slug)) throw new Error("workspace slug: generated value is not valid");
  return slug;
}

/** Outlet codes are short uppercase keys (unique per workspace). */
function outletCode(outletName: string): string {
  const letters = outletName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return letters.length >= 2 ? letters : "MAIN";
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e["code"] === "23505") return true;
    if (e["cause"] && typeof e["cause"] === "object") return (e["cause"] as Record<string, unknown>)["code"] === "23505";
  }
  return false;
}

/** The workspace this Clerk account already owns or belongs to, if any. */
async function existingWorkspace(platformDb: DB, clerkUserId: string): Promise<CreatedWorkspace | null | undefined> {
  const [row] = await platformDb
    .select({ userId: users.id, id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(users)
    .leftJoin(memberships, eq(memberships.userId, users.id))
    .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (!row) return undefined; // not in ORION at all
  return row.id && row.slug && row.name ? { id: row.id, slug: row.slug, name: row.name } : null;
}

export async function provisionWorkspace(
  platformDb: DB,
  clerkUserId: string,
  verifiedEmail: () => Promise<string | null>,
  input: SignupInput,
): Promise<SignupResult> {
  const existing = await existingWorkspace(platformDb, clerkUserId);
  if (existing) return { ok: true, workspace: existing, replay: true };
  if (existing === null) return { ok: false, code: "ALREADY_MEMBER" };

  const rawEmail = await verifiedEmail();
  if (!rawEmail) return { ok: false, code: "EMAIL_NOT_VERIFIED" };
  const email = rawEmail.trim().toLowerCase();
  const [sameEmail] = await platformDb.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (sameEmail) return { ok: false, code: "EMAIL_ALREADY_ADDED", email };

  // Clerk-only account: the password path gets an unusable random hash (as join links do).
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  try {
    const workspace = await platformDb.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ slug: workspaceSlug(input.businessName), name: input.businessName }).returning();
      await tx.insert(tenantSettings).values({ tenantId: tenant!.id });
      // From here on, every row is written as the new workspace.
      await actAsWorkspace(tx, tenant!.id);

      const [owner] = await tx
        .insert(users)
        .values({ name: input.ownerName, email, passwordHash, role: "OWNER", clerkUserId })
        .returning({ id: users.id, name: users.name });
      const [outlet] = await tx
        .insert(locations)
        .values({ code: outletCode(input.outletName), name: input.outletName })
        .returning({ id: locations.id });
      await tx.insert(warehouses).values([
        { locationId: outlet!.id, type: "MAIN" },
        { locationId: outlet!.id, type: "KITCHEN" },
      ]);
      await tx.insert(kitchenStations).values({ locationId: outlet!.id, name: "Kitchen" });
      const [brand] = await tx
        .insert(brands)
        .values({
          locationId: outlet!.id,
          name: input.brandName,
          color: input.brandColor,
          salesPerfId: input.brandName.toLowerCase().replace(/\s+/g, "-"),
        })
        .returning({ id: brands.id });
      await tx.insert(brandOutlet).values({ brandId: brand!.id, locationId: outlet!.id, isActive: true });
      await seedRolePageAccess(tx as unknown as DB);
      await audit(tx as unknown as DB, {
        actorUserId: owner!.id,
        actorName: owner!.name,
        action: "workspace.created",
        description: `${owner!.name} created the workspace ${input.businessName}`,
        entityType: "tenant",
        entityId: tenant!.id,
      });
      await tx.execute(sql.raw("RESET ROLE"));
      return { id: tenant!.id, slug: tenant!.slug, name: tenant!.name };
    });
    return { ok: true, workspace, replay: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A parallel request (double click) created this person's workspace first; this
    // transaction rolled back. Re-read outside it.
    const now = await existingWorkspace(platformDb, clerkUserId);
    if (now) return { ok: true, workspace: now, replay: true };
    return { ok: false, code: "EMAIL_ALREADY_ADDED", email };
  }
}

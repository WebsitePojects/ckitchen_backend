import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { DB } from "./client.js";
import { runMigrations } from "./migrate.js";
import { hashPassword } from "../modules/auth/service.js";
import { seedRolePageAccess } from "../modules/admin/routes.js";
import { seedDefaultDiscounts } from "../modules/discounts/routes.js";
import { seedExampleBudget } from "../modules/purchasing/budget.js";
import {
  departmentEnum,
  employees,
  kitchenStations,
  locations,
  userOutletAccess,
  users,
  warehouses,
  type Role,
} from "./schema.js";

const LOCATION_CODE = "CK1";
const LOCATION_NAME = "CloudKitchen ONE";

/**
 * Maps a system role to a department for the initial employee seed. Covers both
 * v1 (alias) and v2 role values so the map stays total over the `Role` union.
 */
function roleToDepartment(role: Role): typeof departmentEnum.enumValues[number] {
  const map: Record<Role, typeof departmentEnum.enumValues[number]> = {
    // v1 aliases
    SUPER_ADMIN: "ADMIN",
    BRAND_MANAGER: "SALES",
    KITCHEN_STAFF: "KITCHEN",
    WAREHOUSE: "WAREHOUSE",
    SUPPLIER_COORDINATOR: "PURCHASING",
    ACCOUNTANT: "ACCOUNTING",
    RIDER: "SALES",
    // v2 (D24)
    OWNER: "ADMIN",
    OUTLET_MANAGER: "ADMIN",
    KITCHEN_CREW: "KITCHEN",
    WAREHOUSE_MAIN: "WAREHOUSE",
    WAREHOUSE_OUTLET: "WAREHOUSE",
    PURCHASING: "PURCHASING",
    HR: "ADMIN",
    ACCOUNTING: "ACCOUNTING",
  };
  return map[role] ?? "ADMIN";
}

const STATION_NAMES = ["Grill", "Fry", "Prep", "Beverage", "Packing"] as const;

const ADMIN_CREDENTIAL = { email: "admin@cloudkitchen.local", password: "admin123" };

interface SeededUser {
  name: string;
  email: string;
  password: string;
  role: Role;
}

/**
 * One user per v2 role (D24). Emails for the roles that existed in v1 keep their
 * historical address (e.g. kitchen_staff@, warehouse@, supplier_coordinator@,
 * accountant@) so tokens/tests that log in by those addresses keep working — the
 * ROLE is v2 even though the local-part echoes the old name.
 */
const SEED_USERS: SeededUser[] = [
  { name: "Admin", email: ADMIN_CREDENTIAL.email, password: ADMIN_CREDENTIAL.password, role: "OWNER" },
  { name: "Outlet Manager", email: "outlet_manager@cloudkitchen.local", password: "password123", role: "OUTLET_MANAGER" },
  { name: "Brand Manager", email: "brand_manager@cloudkitchen.local", password: "password123", role: "BRAND_MANAGER" },
  { name: "Kitchen Crew", email: "kitchen_staff@cloudkitchen.local", password: "password123", role: "KITCHEN_CREW" },
  { name: "Warehouse Main", email: "warehouse_main@cloudkitchen.local", password: "password123", role: "WAREHOUSE_MAIN" },
  { name: "Warehouse Outlet", email: "warehouse@cloudkitchen.local", password: "password123", role: "WAREHOUSE_OUTLET" },
  { name: "Purchasing", email: "supplier_coordinator@cloudkitchen.local", password: "password123", role: "PURCHASING" },
  { name: "HR", email: "hr@cloudkitchen.local", password: "password123", role: "HR" },
  { name: "Accounting", email: "accountant@cloudkitchen.local", password: "password123", role: "ACCOUNTING" },
];

/**
 * Idempotently seeds: 1 location, 5 kitchen stations linked to it, one user per
 * role (7) plus a dedicated SUPER_ADMIN admin account. Safe to re-run.
 */
export async function seed(db: DB): Promise<SeededUser[]> {
  await runMigrations(db);

  // --- location (idempotent: reuse if already present) -----------------
  let [location] = await db
    .select()
    .from(locations)
    .where(eq(locations.code, LOCATION_CODE));

  if (!location) {
    [location] = await db
      .insert(locations)
      .values({
        code: LOCATION_CODE,
        name: LOCATION_NAME,
        address: "Prototype HQ",
        status: "ACTIVE",
        timezone: "Asia/Manila",
      })
      .returning();
  }

  // --- kitchen stations (idempotent per name+location) ------------------
  const existingStations = await db
    .select()
    .from(kitchenStations)
    .where(eq(kitchenStations.locationId, location.id));
  const existingStationNames = new Set(existingStations.map((s) => s.name));

  for (const name of STATION_NAMES) {
    if (!existingStationNames.has(name)) {
      await db.insert(kitchenStations).values({ locationId: location.id, name });
    }
  }

  // --- warehouses: MAIN and KITCHEN (idempotent per type+location) ------
  const existingWarehouses = await db
    .select()
    .from(warehouses)
    .where(eq(warehouses.locationId, location.id));
  const existingWarehouseTypes = new Set(existingWarehouses.map((w) => w.type));

  for (const type of ["MAIN", "KITCHEN"] as const) {
    if (!existingWarehouseTypes.has(type)) {
      await db.insert(warehouses).values({ locationId: location.id, type });
    }
  }

  // --- users: one per v2 role (idempotent on email) ---------------------
  const seededCreds: SeededUser[] = SEED_USERS;

  for (const candidate of seededCreds) {
    const [existing] = await db.select().from(users).where(eq(users.email, candidate.email));
    if (!existing) {
      await db.insert(users).values({
        name: candidate.name,
        email: candidate.email,
        passwordHash: await hashPassword(candidate.password),
        role: candidate.role,
      });
    }
  }

  // --- user_outlet_access: grant every seeded user the pilot outlet ------
  // (D22/D31) — source of truth for WHERE a user may act. ALL-scope roles don't
  // need a row for authorization, but a row is harmless and keeps the pilot data
  // consistent. Idempotent on (user_id, location_id).
  const seededEmails = seededCreds.map((c) => c.email);
  const seededUserRows = await db.select().from(users);
  for (const usr of seededUserRows) {
    if (!seededEmails.includes(usr.email)) continue;
    const [existingAccess] = await db
      .select()
      .from(userOutletAccess)
      .where(
        and(
          eq(userOutletAccess.userId, usr.id),
          eq(userOutletAccess.locationId, location.id),
        ),
      );
    if (!existingAccess) {
      await db.insert(userOutletAccess).values({ userId: usr.id, locationId: location.id });
    }
  }

  // --- employees: one per seeded user (idempotent on employee_no) ----------
  const allUsers = await db.select().from(users);
  let empSeq = 0;
  for (const usr of allUsers) {
    empSeq += 1;
    const employeeNo = `EMP-${String(empSeq).padStart(4, "0")}`;
    // Check whether this user already has an employee record
    const [existingEmp] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.userId, usr.id));
    if (!existingEmp) {
      // Also guard against employee_no collision (re-run safety)
      const [noConflict] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.employeeNo, employeeNo));
      if (!noConflict) {
        await db.insert(employees).values({
          userId: usr.id,
          employeeNo,
          fullName: usr.name,
          department: roleToDepartment(usr.role),
          position: usr.role.replace(/_/g, " "),
          status: "ACTIVE",
        });
      }
    }
  }

  // --- client-confirmed named people (2026-07-10, enterprise-operations-
  // foundation.md §10) — standalone employee rows (no user_id/login: emails and
  // credentials are a controlled activation input and are never fabricated).
  // attendance_required is explicit per-person, since Owner role alone is not
  // the historical source of an employee's attendance policy. Idempotent on
  // employee_no. seed-pilot.ts has no employee-creation logic of its own (it
  // only adds brands/menu/ingredients on top of this base seed), so these live
  // here alongside the rest of the employee seeding.
  const CLIENT_PEOPLE: Array<{
    employeeNo: string;
    fullName: string;
    department: typeof departmentEnum.enumValues[number];
    position: string;
    attendanceRequired: boolean;
  }> = [
    {
      employeeNo: "EMP-CLIENT-MSERRANO",
      fullName: "Manilyn Serrano",
      department: "ACCOUNTING",
      position: "Accounting Head / section admin",
      attendanceRequired: true,
    },
    {
      employeeNo: "EMP-CLIENT-BBUROG",
      fullName: "Babylyn Burog",
      department: "ADMIN",
      position: "Owner / admin",
      attendanceRequired: false,
    },
    {
      employeeNo: "EMP-CLIENT-BJBUROG",
      fullName: "BJ Burog",
      department: "ADMIN",
      position: "Owner / admin",
      attendanceRequired: false,
    },
  ];
  for (const person of CLIENT_PEOPLE) {
    const [existing] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.employeeNo, person.employeeNo));
    if (!existing) {
      await db.insert(employees).values({
        // userId, photoUrl, hiredAt, locationId: unknown per §10 — stay null,
        // never fabricated.
        employeeNo: person.employeeNo,
        fullName: person.fullName,
        department: person.department,
        position: person.position,
        status: "ACTIVE",
        attendanceRequired: person.attendanceRequired,
      });
    }
  }

  // --- role_page_access matrix (idempotent; preserves later admin edits) ------
  await seedRolePageAccess(db);

  // --- default discount catalog: Senior Citizen + PWD (idempotent) -----------
  const [ownerUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, ADMIN_CREDENTIAL.email));
  if (ownerUser) {
    await seedDefaultDiscounts(db, ownerUser.id);
    await seedExampleBudget(db, ownerUser.id);
  }

  return seededCreds;
}

// `npm run seed` against the default file-backed client:
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { createDb, closeDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath, databaseUrl } = loadConfig();
  const { db, client } = createDb({ dataDir: dbPath, databaseUrl });

  const seededCreds = await seed(db);

  console.log("Seed complete.");
  console.log(`Location: ${LOCATION_NAME}`);
  console.log(`Stations: ${STATION_NAMES.join(", ")}`);
  console.log("");
  console.log("Seeded users (prototype credentials — do not use in production):");
  for (const cred of seededCreds) {
    console.log(`  ${cred.role.padEnd(22)} ${cred.email.padEnd(36)} ${cred.password}`);
  }

  await closeDb(client); // GOTCHA: file-backed PGlite / postgres-js pool keep the loop alive — close or it hangs.
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "./client.js";
import { runMigrations } from "./migrate.js";
import { hashPassword } from "../modules/auth/service.js";
import {
  departmentEnum,
  employees,
  kitchenStations,
  locations,
  users,
  warehouses,
  type Role,
} from "./schema.js";

const LOCATION_CODE = "CK1";
const LOCATION_NAME = "CloudKitchen ONE";

/** Maps a system role to a department for the initial employee seed. */
function roleToDepartment(role: Role): typeof departmentEnum.enumValues[number] {
  const map: Record<Role, typeof departmentEnum.enumValues[number]> = {
    SUPER_ADMIN: "ADMIN",
    BRAND_MANAGER: "SALES",
    KITCHEN_STAFF: "KITCHEN",
    WAREHOUSE: "WAREHOUSE",
    SUPPLIER_COORDINATOR: "PURCHASING",
    ACCOUNTANT: "ACCOUNTING",
    RIDER: "SALES",
  };
  return map[role] ?? "ADMIN";
}

const STATION_NAMES = ["Grill", "Fry", "Prep", "Beverage", "Packing"] as const;

const ADMIN_CREDENTIAL = { email: "admin@cloudkitchen.local", password: "admin123" };

const ROLES: Role[] = [
  "SUPER_ADMIN",
  "BRAND_MANAGER",
  "KITCHEN_STAFF",
  "WAREHOUSE",
  "SUPPLIER_COORDINATOR",
  "ACCOUNTANT",
  "RIDER",
];

interface SeededUser {
  name: string;
  email: string;
  password: string;
  role: Role;
}

function roleUserCredential(role: Role): SeededUser {
  return {
    name: `${role} User`,
    email: `${role.toLowerCase()}@cloudkitchen.local`,
    password: "password123",
    role,
  };
}

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

  // --- users: admin + one per role (idempotent on email) ----------------
  const seededCreds: SeededUser[] = [
    { name: "Admin", email: ADMIN_CREDENTIAL.email, password: ADMIN_CREDENTIAL.password, role: "SUPER_ADMIN" },
    ...ROLES.map(roleUserCredential),
  ];

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

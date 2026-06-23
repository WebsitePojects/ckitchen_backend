import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "./client.js";
import { runMigrations } from "./migrate.js";
import { hashPassword } from "../modules/auth/service.js";
import { kitchenStations, locations, users, warehouses, type Role } from "./schema.js";

const LOCATION_NAME = "Main Cloud Kitchen";

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
    .where(eq(locations.name, LOCATION_NAME));

  if (!location) {
    [location] = await db
      .insert(locations)
      .values({ name: LOCATION_NAME, address: "Prototype HQ" })
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

  return seededCreds;
}

// `npm run seed` against the default file-backed client:
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const { createDb } = await import("./client.js");
  const { loadConfig } = await import("../config.js");
  const { dbPath } = loadConfig();
  const { db, client } = createDb(dbPath);

  const seededCreds = await seed(db);

  console.log("Seed complete.");
  console.log(`Location: ${LOCATION_NAME}`);
  console.log(`Stations: ${STATION_NAMES.join(", ")}`);
  console.log("");
  console.log("Seeded users (prototype credentials — do not use in production):");
  for (const cred of seededCreds) {
    console.log(`  ${cred.role.padEnd(22)} ${cred.email.padEnd(36)} ${cred.password}`);
  }

  await client.close(); // GOTCHA: file-backed PGlite keeps the loop alive — close or it hangs.
}

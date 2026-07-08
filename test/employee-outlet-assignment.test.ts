/**
 * Employee outlet assignment (client 2026-07-09) — migration 0026 +
 * per-outlet employee CRUD scoping + the outlet-side deployment read.
 *
 *   T1 — migration 0026: employee.location_id exists (create + raw-DB read).
 *   T2 — POST/PATCH /employees location_id round-trip, null clears, 404 on an
 *        unknown outlet, and the new GET /employees?location_id= filter.
 *   T3 — RBAC: an ASSIGNED OUTLET_MANAGER may only target their own outlet's
 *        location_id (403 for a foreign outlet, 200 for their own); OWNER is
 *        unrestricted.
 *   T4 — Employee detail/read routes honor ASSIGNED outlet scope.
 *   T5 — GET /outlets/:id/brands: home brands + brand_outlet deployments
 *        (active + inactive), 403 cross-outlet for an ASSIGNED caller, 404 for
 *        an unknown outlet.
 *
 * Full-stack via supertest, in-memory PGlite (isolated from other test files).
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDb, type DB } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { employees } from "../src/db/schema.js";

let app: Express;
let db: DB;

let adminToken: string; // OWNER — ALL scope
let omToken: string; // seeded OUTLET_MANAGER — ASSIGNED to outlet A only

let outletAId: string; // seeded CK1
let outletBId: string; // CK2, created here

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let _seq = 0;
const nextEmpNo = () => `EOA-${Date.now()}-${++_seq}`;

beforeAll(async () => {
  const created = createDb();
  db = created.db;
  await seed(db);
  app = createApp(db);

  adminToken = await login("admin@cloudkitchen.local", "admin123");
  // Seeded by seed.ts: role OUTLET_MANAGER, granted user_outlet_access to the
  // seeded pilot outlet (CK1) only — i.e. ASSIGNED scope, single outlet.
  omToken = await login("outlet_manager@cloudkitchen.local", "password123");

  const outletsRes = await request(app).get("/api/v1/outlets").set("Authorization", `Bearer ${adminToken}`);
  outletAId = (outletsRes.body as Array<{ id: string; code: string }>).find((o) => o.code === "CK1")!.id;

  const outletBRes = await request(app)
    .post("/api/v1/outlets")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code: "EOA2", name: "EOA Second Outlet" });
  expect(outletBRes.status).toBe(201);
  outletBId = outletBRes.body.id as string;
});

// ---------------------------------------------------------------------------
// T1 — migration 0026: employee.location_id column
// ---------------------------------------------------------------------------

describe("T1 — migration 0026: employee.location_id", () => {
  it("create with location_id + read back via API and raw DB", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Migration Check", department: "KITCHEN", location_id: outletAId });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outletAId);

    const [row] = await db.select().from(employees).where(eq(employees.id, res.body.id));
    expect(row).toBeTruthy();
    expect(row!.locationId).toBe(outletAId);
  });

  it("GET /employees rows carry locationId: string | null", async () => {
    const res = await request(app).get("/api/v1/employees").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const emp of res.body as Array<{ locationId: string | null }>) {
      expect(emp.locationId === null || typeof emp.locationId === "string").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — round trip, null clears, 404 unknown outlet, ?location_id filter
// ---------------------------------------------------------------------------

describe("T2 — POST/PATCH /employees location_id", () => {
  it("omitting location_id on create leaves it null (unassigned/HQ)", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Unassigned Hire", department: "KITCHEN" });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBeNull();
  });

  it("PATCH sets location_id, then PATCH null clears it", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Round Trip", department: "KITCHEN" });
    const id = create.body.id as string;
    expect(create.body.locationId).toBeNull();

    const patchSet = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outletAId });
    expect(patchSet.status).toBe(200);
    expect(patchSet.body.locationId).toBe(outletAId);

    const patchClear = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: null });
    expect(patchClear.status).toBe(200);
    expect(patchClear.body.locationId).toBeNull();
  });

  it("POST with an unknown location_id → 404 NOT_FOUND", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Bad Outlet", department: "KITCHEN", location_id: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PATCH with an unknown location_id → 404 NOT_FOUND", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Patch Bad Outlet", department: "KITCHEN" });
    const id = create.body.id as string;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("PATCH /employees/:id with an unknown id → 404 NOT_FOUND", async () => {
    const res = await request(app)
      .patch(`/api/v1/employees/${randomUUID()}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outletAId });
    expect(res.status).toBe(404);
  });
});

describe("T2 — GET /employees?location_id= filter", () => {
  let empAId: string;
  let empBId: string;

  beforeAll(async () => {
    const a = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Filter A", department: "KITCHEN", location_id: outletAId });
    empAId = a.body.id as string;

    const b = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Filter B", department: "KITCHEN", location_id: outletBId });
    empBId = b.body.id as string;
  });

  it("returns only employees at the given outlet", async () => {
    const resA = await request(app)
      .get(`/api/v1/employees?location_id=${outletAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resA.status).toBe(200);
    const idsA = (resA.body as Array<{ id: string }>).map((e) => e.id);
    expect(idsA).toContain(empAId);
    expect(idsA).not.toContain(empBId);

    const resB = await request(app)
      .get(`/api/v1/employees?location_id=${outletBId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resB.status).toBe(200);
    const idsB = (resB.body as Array<{ id: string }>).map((e) => e.id);
    expect(idsB).toContain(empBId);
    expect(idsB).not.toContain(empAId);
  });

  it("a malformed location_id → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/employees?location_id=not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("ASSIGNED OUTLET_MANAGER cannot GET foreign employees by location_id", async () => {
    const res = await request(app)
      .get(`/api/v1/employees?location_id=${outletBId}`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ASSIGNED OUTLET_MANAGER unfiltered GET excludes foreign and unassigned employees", async () => {
    const unassigned = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Assigned Scope HQ", department: "KITCHEN" });
    expect(unassigned.status).toBe(201);
    expect(unassigned.body.locationId).toBeNull();

    const res = await request(app).get("/api/v1/employees").set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; locationId: string | null }>;
    expect(rows.some((e) => e.id === empAId)).toBe(true);
    expect(rows.some((e) => e.id === empBId)).toBe(false);
    expect(rows.some((e) => e.id === unassigned.body.id)).toBe(false);
    expect(rows.every((e) => e.locationId === outletAId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3 — RBAC: ASSIGNED OUTLET_MANAGER scope-checked on location_id
// ---------------------------------------------------------------------------

describe("T3 — OUTLET_MANAGER (ASSIGNED) scope on POST/PATCH /employees", () => {
  it("POST targeting a foreign outlet → 403 FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${omToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Foreign", department: "KITCHEN", location_id: outletBId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("POST targeting their own outlet → 201", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${omToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Own Outlet", department: "KITCHEN", location_id: outletAId });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outletAId);
  });

  it("POST omitting location_id resolves to their own outlet", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${omToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Implicit Own Outlet", department: "KITCHEN" });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outletAId);
  });

  it("POST with location_id:null is rejected", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${omToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Null Outlet", department: "KITCHEN", location_id: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("PATCH targeting a foreign outlet → 403 FORBIDDEN", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Patch Target", department: "KITCHEN" });
    const id = create.body.id as string;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${omToken}`)
      .send({ location_id: outletBId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("PATCH targeting their own outlet → 200", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Patch Own", department: "KITCHEN", location_id: outletAId });
    const id = create.body.id as string;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${omToken}`)
      .send({ location_id: outletAId });
    expect(res.status).toBe(200);
    expect(res.body.locationId).toBe(outletAId);
  });

  it("PATCH cannot mutate a foreign employee without location_id", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Foreign Field Target", department: "KITCHEN", location_id: outletBId });
    const id = create.body.id as string;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${omToken}`)
      .send({ full_name: "Should Not Mutate" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("PATCH cannot clear their own employee to null", async () => {
    const create = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Clear Own", department: "KITCHEN", location_id: outletAId });
    const id = create.body.id as string;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set("Authorization", `Bearer ${omToken}`)
      .send({ location_id: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("OWNER is unrestricted: can target any real outlet", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "Owner Any Outlet", department: "KITCHEN", location_id: outletBId });
    expect(res.status).toBe(201);
    expect(res.body.locationId).toBe(outletBId);
  });
});

// ---------------------------------------------------------------------------
// T4 — employee detail/read routes honor ASSIGNED outlet scope
// ---------------------------------------------------------------------------

describe("T4 — OUTLET_MANAGER (ASSIGNED) scope on employee detail/read routes", () => {
  let ownEmployeeId: string;
  let foreignEmployeeId: string;
  let unassignedEmployeeId: string;

  beforeAll(async () => {
    const own = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Detail Own", department: "KITCHEN", location_id: outletAId });
    expect(own.status).toBe(201);
    ownEmployeeId = own.body.id as string;

    const foreign = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Detail Foreign", department: "KITCHEN", location_id: outletBId });
    expect(foreign.status).toBe(201);
    foreignEmployeeId = foreign.body.id as string;

    const unassigned = await request(app)
      .post("/api/v1/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employee_no: nextEmpNo(), full_name: "OM Detail HQ", department: "KITCHEN" });
    expect(unassigned.status).toBe(201);
    expect(unassigned.body.locationId).toBeNull();
    unassignedEmployeeId = unassigned.body.id as string;
  });

  it("cannot fetch profile for a foreign outlet employee", async () => {
    const res = await request(app)
      .get(`/api/v1/employees/${foreignEmployeeId}/profile`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("can fetch profile for an own outlet employee", async () => {
    const res = await request(app)
      .get(`/api/v1/employees/${ownEmployeeId}/profile`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.id).toBe(ownEmployeeId);
  });

  it("OWNER can fetch profile for an unassigned or HQ employee", async () => {
    const res = await request(app)
      .get(`/api/v1/employees/${unassignedEmployeeId}/profile`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.id).toBe(unassignedEmployeeId);
  });

  it("ASSIGNED OUTLET_MANAGER cannot read an unassigned or HQ employee", async () => {
    const routes = [
      `/api/v1/employees/${unassignedEmployeeId}/profile`,
      `/api/v1/ems/attendance?employee_id=${unassignedEmployeeId}`,
      `/api/v1/ems/attendance/dtr?employee_id=${unassignedEmployeeId}`,
    ];

    for (const path of routes) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${omToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("cannot fetch attendance for a foreign employee_id", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${foreignEmployeeId}`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("can fetch attendance for an own employee_id", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${ownEmployeeId}`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("OWNER can fetch attendance for an unassigned or HQ employee", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance?employee_id=${unassignedEmployeeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("cannot fetch DTR for a foreign employee_id", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${foreignEmployeeId}`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("can fetch DTR for an own employee_id", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${ownEmployeeId}`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("OWNER can fetch DTR for an unassigned or HQ employee", async () => {
    const res = await request(app)
      .get(`/api/v1/ems/attendance/dtr?employee_id=${unassignedEmployeeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T5 — GET /outlets/:id/brands
// ---------------------------------------------------------------------------

describe("T5 — GET /outlets/:id/brands", () => {
  let brandAId: string; // home = outlet A
  let brandBId: string; // home = outlet B, deployed to A

  beforeAll(async () => {
    const a = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "EOA Brand A", color: "#111111", location_id: outletAId });
    expect(a.status).toBe(201);
    brandAId = a.body.id as string;

    const b = await request(app)
      .post("/api/v1/brands")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "EOA Brand B", color: "#222222", location_id: outletBId });
    expect(b.status).toBe(201);
    brandBId = b.body.id as string;

    const deploy = await request(app)
      .post(`/api/v1/brands/${brandBId}/outlets`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ location_id: outletAId });
    expect(deploy.status).toBe(201);
  });

  it("home brand: home:true, isActive:null, deployedAt:null", async () => {
    const res = await request(app)
      .get(`/api/v1/outlets/${outletAId}/brands`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{
      brandId: string;
      home: boolean;
      isActive: boolean | null;
      deployedAt: string | null;
    }>;

    const homeEntry = rows.find((r) => r.brandId === brandAId);
    expect(homeEntry).toBeTruthy();
    expect(homeEntry!.home).toBe(true);
    expect(homeEntry!.isActive).toBeNull();
    expect(homeEntry!.deployedAt).toBeNull();

    const deployedEntry = rows.find((r) => r.brandId === brandBId);
    expect(deployedEntry).toBeTruthy();
    expect(deployedEntry!.home).toBe(false);
    expect(deployedEntry!.isActive).toBe(true);
    expect(typeof deployedEntry!.deployedAt).toBe("string");
  });

  it("deactivated deployment still listed (home:false, isActive:false)", async () => {
    const del = await request(app)
      .delete(`/api/v1/brands/${brandBId}/outlets/${outletAId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/outlets/${outletAId}/brands`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ brandId: string; home: boolean; isActive: boolean | null }>;
    const deployedEntry = rows.find((r) => r.brandId === brandBId);
    expect(deployedEntry).toBeTruthy();
    expect(deployedEntry!.home).toBe(false);
    expect(deployedEntry!.isActive).toBe(false);
  });

  it("no duplicate entry for a brand that is both home and has its own brand_outlet row", async () => {
    const res = await request(app)
      .get(`/api/v1/outlets/${outletAId}/brands`)
      .set("Authorization", `Bearer ${adminToken}`);
    const rows = res.body as Array<{ brandId: string }>;
    const countForBrandA = rows.filter((r) => r.brandId === brandAId).length;
    expect(countForBrandA).toBe(1);
  });

  it("ASSIGNED OUTLET_MANAGER: 403 for a foreign outlet, 200 for their own", async () => {
    const forbidden = await request(app)
      .get(`/api/v1/outlets/${outletBId}/brands`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");

    const allowed = await request(app)
      .get(`/api/v1/outlets/${outletAId}/brands`)
      .set("Authorization", `Bearer ${omToken}`);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body)).toBe(true);
  });

  it("unknown outlet id → 404 NOT_FOUND", async () => {
    const res = await request(app)
      .get(`/api/v1/outlets/${randomUUID()}/brands`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("malformed outlet id → controlled 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .get("/api/v1/outlets/not-a-uuid/brands")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

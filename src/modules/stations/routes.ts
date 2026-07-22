import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../../db/client.js";
import { kitchenStations, printerConnectionEnum, printers } from "../../db/schema.js";
import { requireAuth, requireRole, resolveOutletContext } from "../auth/middleware.js";
import { resolveRequestLocationId } from "../auth/outlet-scope.js";
import { sendError } from "../http-errors.js";

const WRITE_ROLES = ["OWNER"] as const;

// Outlet-scoping leak fix (M6): additive-only filter for GET /stations.
// Omitted = unchanged platform-wide behavior; supplied = only that outlet's
// stations. NOTE: `printer` has no location_id column of its own (a printer's
// outlet is only implied transitively via whichever station(s) reference it
// as default_printer_id), so GET /printers is NOT filterable the same way —
// see the audit note on that route below.
const stationListQuerySchema = z.object({
  location_id: z.string().uuid().optional(),
});

const createStationSchema = z.object({
  name: z.string().min(1),
  default_printer_id: z.string().uuid().optional(),
  // Outlet targeting (D22): ALL-scope users may name any outlet; ASSIGNED users
  // are membership-checked. Omitted → the deployment's default (first) outlet.
  location_id: z.string().uuid().optional(),
});

const createPrinterSchema = z.object({
  name: z.string().min(1),
  connection: z.enum(printerConnectionEnum.enumValues),
  address: z.string().min(1),
});

const updatePrinterSchema = z
  .object({
    name: z.string().min(1).optional(),
    connection: z.enum(printerConnectionEnum.enumValues).optional(),
    address: z.string().min(1).optional(),
    status: z.enum(["ONLINE", "OFFLINE", "ERROR"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field is required.",
  });

export function createStationsRouter(db: DB): Router {
  const router = Router();

  router.get("/stations", requireAuth, async (req, res) => {
    const queryParsed = stationListQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "'location_id' must be a UUID.", queryParsed.error.issues);
      return;
    }

    const stations = queryParsed.data.location_id
      ? await db.select().from(kitchenStations).where(eq(kitchenStations.locationId, queryParsed.data.location_id))
      : await db.select().from(kitchenStations);
    const allPrinters = await db.select().from(printers);
    const printersById = new Map(allPrinters.map((p) => [p.id, p]));

    const result = stations.map((station) => ({
      ...station,
      defaultPrinter: station.defaultPrinterId
        ? printersById.get(station.defaultPrinterId) ?? null
        : null,
    }));

    res.json(result);
  });

  router.post("/stations", requireAuth, requireRole(...WRITE_ROLES), resolveOutletContext, async (req, res) => {
    const parsed = createStationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid station payload.", parsed.error.issues);
      return;
    }

    if (parsed.data.default_printer_id) {
      const [printer] = await db
        .select()
        .from(printers)
        .where(eq(printers.id, parsed.data.default_printer_id));
      if (!printer) {
        sendError(res, 404, "NOT_FOUND", "default_printer_id does not reference an existing printer.");
        return;
      }
    }

    const locationId = await resolveRequestLocationId(db, req, res, parsed.data.location_id);
    if (!locationId) return;

    const [station] = await db
      .insert(kitchenStations)
      .values({
        locationId,
        name: parsed.data.name,
        defaultPrinterId: parsed.data.default_printer_id,
      })
      .returning();

    res.status(201).json(station);
  });

  // Outlet-scoping audit (M6): `printer` has NO location_id column — a
  // printer's outlet is only implied transitively via kitchen_station.
  // default_printer_id, and that is not a 1:1 relation (a printer could in
  // theory be referenced by stations at different outlets), so an optional
  // ?location_id= filter cannot be added here with the same safe, direct
  // pattern used for /brands and /stations. Left unfiltered; documented for
  // the frontend and for a future fix if printer-per-outlet ownership becomes
  // an explicit column.
  router.get("/printers", requireAuth, async (_req, res) => {
    const rows = await db.select().from(printers);
    res.json(rows);
  });

  router.post("/printers", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = createPrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid printer payload.", parsed.error.issues);
      return;
    }

    const [printer] = await db
      .insert(printers)
      .values({
        name: parsed.data.name,
        connection: parsed.data.connection,
        address: parsed.data.address,
      })
      .returning();

    res.status(201).json(printer);
  });

  router.patch("/printers/:id", requireAuth, requireRole(...WRITE_ROLES), async (req, res) => {
    const parsed = updatePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", "Invalid printer payload.", parsed.error.issues);
      return;
    }

    const [existing] = await db.select().from(printers).where(eq(printers.id, String(req.params.id)));
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Printer not found.");
      return;
    }

    const [updated] = await db
      .update(printers)
      .set(parsed.data)
      .where(eq(printers.id, String(req.params.id)))
      .returning();

    res.json(updated);
  });

  return router;
}

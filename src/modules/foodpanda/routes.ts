import { Router } from "express";
import type { ZodError } from "zod";
import type { DB } from "../../db/client.js";
import { paramAsString, sendError } from "../http-errors.js";
import { requireFoodpandaPluginJwt } from "./auth.js";
import { FoodpandaPluginError, handleAvailability, handleCatalogCallback, handleDispatchOrder, handleMenuImportTrigger, handleOrderStatus } from "./service.js";
import {
  availabilitySchema,
  boundedCallback,
  boundedId,
  catalogCallbackSchema,
  menuImportQuerySchema,
  orderDispatchBodySchema,
  orderStatusSchema,
} from "./validation.js";

function validationDetails(err: ZodError): unknown {
  return err.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof FoodpandaPluginError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  if (err && typeof err === "object" && "issues" in err) {
    sendError(res, 400, "VALIDATION_ERROR", "Invalid Foodpanda Plugin API request.", validationDetails(err as ZodError));
    return;
  }
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

function parsePathId(value: string | string[] | undefined, field: string): string {
  const parsed = boundedId.safeParse(paramAsString(value));
  if (!parsed.success) {
    throw new FoodpandaPluginError("VALIDATION_ERROR", `${field} must be a non-empty bounded string.`, 400, validationDetails(parsed.error));
  }
  return parsed.data;
}

export function createFoodpandaPluginRouter(db: DB): Router {
  const router = Router();
  router.use(requireFoodpandaPluginJwt);

  router.post("/order/:remoteId", async (req, res) => {
    try {
      const remoteId = parsePathId(req.params.remoteId, "remoteId");
      const body = orderDispatchBodySchema.parse(req.body);
      const result = await handleDispatchOrder(db, { remoteId, body });
      res.status(200).json({ remoteResponse: { remoteOrderId: result.remoteOrderId } });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.put("/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus", async (req, res) => {
    try {
      const remoteId = parsePathId(req.params.remoteId, "remoteId");
      const remoteOrderId = parsePathId(req.params.remoteOrderId, "remoteOrderId");
      const body = orderStatusSchema.parse(req.body);
      await handleOrderStatus(db, { remoteId, remoteOrderId, body });
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  router.put("/remoteId/:remoteId/availability", async (req, res) => {
    try {
      const remoteId = parsePathId(req.params.remoteId, "remoteId");
      const body = availabilitySchema.parse(req.body);
      await handleAvailability(db, { remoteId, body });
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get("/menuimport/:remoteId", async (req, res) => {
    try {
      const remoteId = parsePathId(req.params.remoteId, "remoteId");
      const query = menuImportQuerySchema.parse(req.query);
      await handleMenuImportTrigger(db, { remoteId, vendorCode: query.vendorCode, menuImportId: query.menuImportId });
      res.status(202).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post("/:catalogImportCallback", async (req, res) => {
    try {
      const parsedCallback = boundedCallback.safeParse(paramAsString(req.params.catalogImportCallback));
      if (!parsedCallback.success) {
        throw new FoodpandaPluginError("VALIDATION_ERROR", "catalogImportCallback must be a bounded route token.", 400, validationDetails(parsedCallback.error));
      }
      const body = catalogCallbackSchema.parse(req.body);
      await handleCatalogCallback(db, { callbackRoute: parsedCallback.data, body });
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

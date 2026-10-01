import { Router, type Response } from "express";
import type { ZodError } from "zod";
import type { DB } from "../../db/client.js";
import { sendError } from "../http-errors.js";
import { assertGrabPartnerConfigured, createGrabPartnerOauthRateLimiter, GrabPartnerAuthError, issueGrabPartnerToken, requireGrabPartnerBearer } from "./auth.js";
import {
  GrabPartnerServiceError,
  getMerchantMenu,
  handleMenuSyncState,
  handlePushGrabMenu,
  handlePushIntegrationStatus,
  handlePushOrderState,
  handleSubmitOrder,
} from "./service.js";
import {
  getMerchantMenuQuerySchema,
  grabOauthTokenBodySchema,
  menuSyncStateBodySchema,
  pushGrabMenuBodySchema,
  pushIntegrationStatusBodySchema,
  pushOrderStateBodySchema,
  submitOrderBodySchema,
} from "./validation.js";

function validationDetails(err: ZodError): unknown {
  return err.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof GrabPartnerAuthError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  if (err instanceof GrabPartnerServiceError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  if (err && typeof err === "object" && "issues" in err) {
    sendError(res, 400, "VALIDATION_ERROR", "Invalid GrabFood Partner API request.", validationDetails(err as ZodError));
    return;
  }
  // Anything else is an unexpected internal failure — never answer it with a
  // 2XX (Grab's own menuSyncState contract note: "never answer a transient
  // internal failure with a 200"). The global errorHandler (app.ts) also
  // normalizes this, but routes.ts owns its own 500 so behaviour is identical
  // whether or not this router is mounted standalone (as it is in tests).
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}

/**
 * GrabFood Partner API v1.1.3 inbound router. G1 (oauth/token) is mounted
 * BEFORE the bearer-auth gate — it IS the credential endpoint, throttled
 * instead (rule 12). Every other route (G3-G8) requires the bearer token
 * minted by G1.
 */
export function createGrabPartnerRouter(db: DB): Router {
  const router = Router();

  router.post("/oauth/token", createGrabPartnerOauthRateLimiter(), (req, res) => {
    try {
      // Gate BEFORE body validation (the rate limiter above still runs first): an
      // unconfigured/misconfigured integration must answer 503 whatever the caller
      // sends, never a 400 that blames the caller for our env-var mistake.
      assertGrabPartnerConfigured();
      const body = grabOauthTokenBodySchema.parse(req.body);
      const token = issueGrabPartnerToken(body);
      res.status(200).json(token);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.use(requireGrabPartnerBearer);

  // G3 — Submit order webhook. Quick-validate, persist PENDING, ack fast;
  // worker.ts does the mapping/ingestion off the request path.
  router.post("/orders", async (req, res) => {
    try {
      const body = submitOrderBodySchema.parse(req.body);
      if (!body.partnerMerchantID) {
        throw new GrabPartnerServiceError("VALIDATION_ERROR", "partnerMerchantID is required to resolve the channel listing.", 400);
      }
      const result = await handleSubmitOrder(db, { partnerMerchantId: body.partnerMerchantID, body });
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // G4 — Push order state webhook.
  router.put("/order/state", async (req, res) => {
    try {
      const body = pushOrderStateBodySchema.parse(req.body);
      if (!body.partnerMerchantID) {
        throw new GrabPartnerServiceError("VALIDATION_ERROR", "partnerMerchantID is required to resolve the channel listing.", 400);
      }
      await handlePushOrderState(db, { partnerMerchantId: body.partnerMerchantID, body });
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  // G5 — Push integration status webhook. MUST return 204 No Content.
  router.post("/pushIntegrationStatus", async (req, res) => {
    try {
      const body = pushIntegrationStatusBodySchema.parse(req.body);
      await handlePushIntegrationStatus(db, body);
      res.status(204).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  // G6 — Menu sync state webhook.
  router.post("/menuSyncState", async (req, res) => {
    try {
      const body = menuSyncStateBodySchema.parse(req.body);
      await handleMenuSyncState(db, body);
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  // G7 — Push Grab menu webhook.
  router.post("/pushGrabMenu", async (req, res) => {
    try {
      const body = pushGrabMenuBodySchema.parse(req.body);
      await handlePushGrabMenu(db, { body });
      res.status(200).send();
    } catch (err) {
      handleError(err, res);
    }
  });

  // G8 — Get food menu webhook.
  router.get("/merchant/menu", async (req, res) => {
    try {
      const query = getMerchantMenuQuerySchema.parse(req.query);
      const menu = await getMerchantMenu(db, query);
      res.status(200).json(menu);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

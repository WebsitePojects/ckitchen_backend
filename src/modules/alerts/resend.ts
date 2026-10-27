/**
 * Resend provider boundary: the ONLY module that talks to Resend's API.
 *
 * The caller passes a stable idempotency key (the alert_email id) and the frozen request, so a
 * retry after a timeout or a crash is the identical request and Resend returns the original
 * result instead of sending a second email (keys are kept 24 h).
 * Never throws: every outcome is classified as sent, retry later, or give up.
 */
export interface OutgoingEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; message: string };

export type SendEmail = (apiKey: string, email: OutgoingEmail, idempotencyKey: string) => Promise<SendOutcome>;

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;
const MAX_ERROR_CHARS = 300;

/** Errors worth retrying: rate limits, quota resets, provider outages, and in-flight duplicates. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_409 = new Set(["concurrent_idempotent_requests", "resource_locked"]);

function truncate(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

export function createResendSender(fetchImpl: typeof fetch = fetch): SendEmail {
  return async (apiKey, email, idempotencyKey) => {
    let response: Response;
    try {
      response = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(email),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: the email may or may not have been accepted. Retrying with
      // the same key is safe either way.
      return { ok: false, retryable: true, message: truncate(`Resend unreachable: ${err instanceof Error ? err.message : String(err)}`) };
    }

    const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown; message?: unknown } | null;
    if (response.ok) {
      return { ok: true, providerMessageId: typeof body?.id === "string" ? body.id : "" };
    }

    const name = typeof body?.name === "string" ? body.name : "unknown_error";
    const detail = typeof body?.message === "string" ? body.message : response.statusText;
    const retryable = RETRYABLE_STATUS.has(response.status) || (response.status === 409 && RETRYABLE_409.has(name));
    return { ok: false, retryable, message: truncate(`Resend ${response.status} ${name}: ${detail}`) };
  };
}

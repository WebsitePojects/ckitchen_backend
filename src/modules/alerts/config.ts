/**
 * Owner email alert settings, read from the environment.
 *
 *   RESEND_API_KEY            enables alerts (re_...); unset = alerts off, nothing is scanned
 *   ALERT_EMAIL_FROM          sender on a domain verified in Resend,
 *                             e.g. "ORION Alerts <alerts@orion.princeitsolutions.tech>"
 *   ALERT_EMAIL_TO            optional extra recipients, comma-separated (owners always get it)
 *   ALERT_APP_URL             optional frontend origin for the "open ORION" link
 *   ALERT_ORDER_UNATTENDED_MINUTES  order still NEW after this long (default 15)
 *   ALERT_ORDER_STUCK_MINUTES       order PREPARING for this long (default 60)
 *
 * A half-configured setup (key without a valid sender, a malformed address or number) is a
 * problem, not a silent default: alerts stay off and the worker logs why at startup.
 */
export interface AlertSettings {
  resendApiKey: string;
  from: string;
  extraRecipients: string[];
  appUrl: string | null;
  unattendedMinutes: number;
  stuckMinutes: number;
}

export type AlertSettingsResult =
  | { ok: true; settings: AlertSettings }
  | { ok: false; reason: string };

type Env = Readonly<Record<string, string | undefined>>;

const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
const NAMED_EMAIL_RE = /^[^<>]{1,80}<([^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+)>$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value);
}

function minutes(env: Env, name: string, fallback: number): number | string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    return `${name} "${raw}" must be a whole number of minutes from 1 to 1440.`;
  }
  return value;
}

export function readAlertSettings(env: Env = process.env): AlertSettingsResult {
  const resendApiKey = env.RESEND_API_KEY?.trim();
  if (!resendApiKey) return { ok: false, reason: "RESEND_API_KEY not set" };

  const from = env.ALERT_EMAIL_FROM?.trim() ?? "";
  if (!isEmailAddress(from) && !NAMED_EMAIL_RE.test(from)) {
    return { ok: false, reason: 'ALERT_EMAIL_FROM must be "Name <address@verified-domain>" or a bare address' };
  }

  const extraRecipients = (env.ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const badRecipient = extraRecipients.find((r) => !isEmailAddress(r));
  if (badRecipient) return { ok: false, reason: "ALERT_EMAIL_TO contains an entry that is not an email address" };

  const appUrlRaw = env.ALERT_APP_URL?.trim() || null;
  if (appUrlRaw && !/^https?:\/\/[^\s]+$/.test(appUrlRaw)) {
    return { ok: false, reason: "ALERT_APP_URL must start with https:// (or http:// for local testing)" };
  }

  const unattendedMinutes = minutes(env, "ALERT_ORDER_UNATTENDED_MINUTES", 15);
  if (typeof unattendedMinutes === "string") return { ok: false, reason: unattendedMinutes };
  const stuckMinutes = minutes(env, "ALERT_ORDER_STUCK_MINUTES", 60);
  if (typeof stuckMinutes === "string") return { ok: false, reason: stuckMinutes };

  return {
    ok: true,
    settings: {
      resendApiKey,
      from,
      extraRecipients,
      appUrl: appUrlRaw ? appUrlRaw.replace(/\/+$/, "") : null,
      unattendedMinutes,
      stuckMinutes,
    },
  };
}

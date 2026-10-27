/**
 * Turns open alerts into one digest email (subject, plain text, HTML).
 *
 * Every value that came from the database (item, brand and outlet names, order refs) is
 * HTML-escaped: names are typed by staff, and an email client renders whatever it is given.
 */
import type { AlertKind } from "../../db/schema.js";

export type AlertDetails = Record<string, string | number | null>;

export interface RenderableAlert {
  kind: AlertKind;
  details: AlertDetails;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RenderOptions {
  now: Date;
  timezone: string;
  appUrl: string | null;
}

const CHANNEL_LABEL: Record<string, string> = { GRABFOOD: "GrabFood", FOODPANDA: "foodpanda", OTHER: "Walk-in" };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const str = (details: AlertDetails, key: string): string => {
  const value = details[key];
  return value === null || value === undefined ? "" : String(value);
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function quantity(raw: string): string {
  const value = Number(raw);
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : raw;
}

function minutesSince(iso: string, now: Date): number {
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : 0;
}

interface Section {
  title: string;
  headers: string[];
  rows: string[][];
}

function orderSection(title: string, alerts: RenderableAlert[], sinceKey: string, opts: RenderOptions): Section {
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: opts.timezone, hour: "numeric", minute: "2-digit" });
  return {
    title,
    headers: ["Order", "Brand", "Outlet", "Channel", "Placed", "Waiting"],
    rows: alerts.map(({ details }) => [
      str(details, "ref"),
      str(details, "brand"),
      str(details, "outlet") || "-",
      CHANNEL_LABEL[str(details, "channel")] ?? str(details, "channel"),
      clock.format(new Date(str(details, "placedAt"))),
      `${minutesSince(str(details, sinceKey), opts.now)} min`,
    ]),
  };
}

export function renderAlertDigest(alerts: RenderableAlert[], opts: RenderOptions): RenderedEmail {
  const unattended = alerts.filter((a) => a.kind === "ORDER_UNATTENDED");
  const stuck = alerts.filter((a) => a.kind === "ORDER_STUCK");
  const lowStock = alerts.filter((a) => a.kind === "LOW_STOCK");

  const sections: Section[] = [];
  const summary: string[] = [];
  if (unattended.length > 0) {
    summary.push(`${plural(unattended.length, "order", "orders")} not started`);
    sections.push(orderSection("Orders nobody has started", unattended, "placedAt", opts));
  }
  if (stuck.length > 0) {
    summary.push(`${plural(stuck.length, "order", "orders")} stuck in the kitchen`);
    sections.push(orderSection("Orders cooking too long", stuck, "prepAt", opts));
  }
  if (lowStock.length > 0) {
    summary.push(`${plural(lowStock.length, "item", "items")} low on stock`);
    sections.push({
      title: "Kitchen stock at or below its low-stock level",
      headers: ["Item", "Outlet", "On hand", "Low-stock level"],
      rows: lowStock.map(({ details }) => [
        str(details, "item"),
        str(details, "outlet"),
        `${quantity(str(details, "quantity"))} ${str(details, "unit")}`,
        `${quantity(str(details, "threshold"))} ${str(details, "unit")}`,
      ]),
    });
  }

  const subject = `ORION alert: ${summary.join(", ")}`;
  const footer = opts.appUrl ? `Open ORION: ${opts.appUrl}` : "Open ORION to act on these.";

  const text = [
    subject,
    "",
    ...sections.flatMap((s) => [s.title, ...s.rows.map((r) => `- ${r.join(" | ")}`), ""]),
    footer,
    "You get this because you are an owner in ORION. Each problem is emailed once; if it clears and happens again, you are told again.",
  ].join("\n");

  const cell = "padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:14px;";
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px">`,
    `<h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(subject)}</h2>`,
    ...sections.map(
      (s) =>
        `<h3 style="margin:20px 0 6px;font-size:15px">${escapeHtml(s.title)}</h3>` +
        `<table style="border-collapse:collapse;width:100%"><thead><tr>${s.headers
          .map((h) => `<th style="${cell}color:#6b7280;font-weight:600">${escapeHtml(h)}</th>`)
          .join("")}</tr></thead><tbody>${s.rows
          .map((r) => `<tr>${r.map((v) => `<td style="${cell}">${escapeHtml(v)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
    ),
    opts.appUrl
      ? `<p style="margin:20px 0"><a href="${escapeHtml(opts.appUrl)}" style="background:#059669;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open ORION</a></p>`
      : `<p style="margin:20px 0">Open ORION to act on these.</p>`,
    `<p style="color:#6b7280;font-size:12px">You get this because you are an owner in ORION. Each problem is emailed once; if it clears and happens again, you are told again.</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

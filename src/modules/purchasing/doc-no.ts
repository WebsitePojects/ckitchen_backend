/**
 * Document number generator for purchasing/receiving paperwork (ERP R3).
 *
 * `PR-…` / `PO-…` / `RR-…` — timestamp + 4 random digits. Extracted from
 * purchasing/routes.ts (0024) so the DIRECT-receive path in inventory/routes.ts
 * can stamp its Receiving Reports with the SAME `RR-…` series as the PO-receive
 * path — one RR register, one numbering scheme, regardless of how stock arrived.
 */
export function docNo(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4).toString().padStart(4, "0")}`;
}

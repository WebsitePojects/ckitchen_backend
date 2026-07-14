/**
 * Discount evidence service — W4 spec §10 ("Discounts") private-evidence contract.
 *
 * SENIOR/PWD (and, optionally, other variable) discounts capture an ID-image as
 * proof. That image is PRIVATE: never a permanent public URL, stripped of
 * EXIF/metadata before storage, MIME/size-validated before decode, excluded from
 * ordinary order/discount responses, and readable only through a short-lived
 * signed URL whose every issuance is durably audited in
 * `discount_evidence_access_log` (src/db/w4-schema.ts).
 *
 * EXIF-STRIPPING DECISION: `sharp` is NOT installed in this backend (checked
 * package.json + node_modules) and the build rule here is "no new deps without
 * reporting the decision" — pulling in sharp (a native binary, tens of MB per
 * platform) for this alone was judged not worth it. Instead this module does a
 * minimal MANUAL strip of the metadata-bearing segments/chunks:
 *   - JPEG: drops APP1-APPF marker segments (0xFFE1-0xFFEF — this is where
 *     EXIF, XMP, and Photoshop IRB data live) and COM (0xFFFE) comment
 *     segments, while preserving APP0 (JFIF) and all image-data segments
 *     untouched. Segment boundaries are walked directly off the JPEG marker
 *     structure — no re-encode, so image bytes/quality are unaffected.
 *   - PNG: drops ancillary metadata chunks eXIf, tEXt, zTXt, iTXt, tIME while
 *     preserving all critical chunks (IHDR/PLTE/IDAT/IEND) and
 *     rendering-relevant ancillary chunks (tRNS/gAMA/iCCP/pHYs/...).
 *   - WEBP: drops the RIFF EXIF/XMP sub-chunks and rewrites the RIFF
 *     container size header.
 * This removes camera GPS/serial/timestamp EXIF data (the privacy-sensitive
 * payload) without a native image-processing dependency. If sharp is added to
 * this repo for other reasons later, swapping the JPEG/PNG/WEBP branches below
 * for sharp(buffer).rotate().toBuffer() (drops EXIF by default while
 * auto-applying the EXIF orientation first) would be a strict upgrade —
 * flagged here for that future migration.
 *
 * STORAGE: a small provider interface with two implementations, selected by
 * env (CLOUDINARY_* present => Cloudinary; otherwise LocalFsProvider):
 *   - CloudinaryPrivateProvider: uploads with `type: "private"` (never the
 *     public delivery type used by ems/cloudinary.ts's uploadImage) and mints
 *     a Cloudinary-signed, time-limited download URL per access.
 *   - LocalFsProvider: writes under `./.evidence/` (gitignored) and mints a
 *     short-lived HMAC-signed token consumed by `GET /discount-evidence/:token`
 *     (src/modules/discounts/routes.ts) — the dev/test fallback so this module
 *     never depends on real Cloudinary credentials being present.
 * Neither path ever returns a permanent/public URL for evidence.
 */
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { v2 as cloudinary } from "cloudinary";
import type { DB } from "../../db/client.js";
import { discountEvidenceAccessLogs } from "../../db/w4-schema.js";
import { loadConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class EvidenceValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceValidationError";
    this.code = code;
  }
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

interface ParsedDataUrl {
  mime: string;
  buffer: Buffer;
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Validates MIME + size BEFORE the (cheap but not free) base64 decode, per
 * spec: "MIME/size validated" ahead of storage. Approximate size is checked
 * off the base64 string length first (base64 expands bytes by ~4/3) so an
 * oversized payload is rejected without ever materializing the full decoded
 * buffer; the exact decoded length is re-checked after decode as a backstop.
 */
function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) {
    throw new EvidenceValidationError("EVIDENCE_INVALID", "evidence_image must be a data:<mime>;base64,<data> URI.");
  }
  const mime = match[1].toLowerCase();
  const b64 = match[2];
  if (!ALLOWED_MIME.has(mime)) {
    throw new EvidenceValidationError(
      "EVIDENCE_INVALID_MIME",
      `Unsupported evidence MIME type "${mime}". Allowed: ${Array.from(ALLOWED_MIME).join(", ")}.`,
    );
  }
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    throw new EvidenceValidationError("EVIDENCE_TOO_LARGE", `Evidence image exceeds the ${MAX_BYTES} byte cap.`);
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(b64, "base64");
  } catch {
    throw new EvidenceValidationError("EVIDENCE_INVALID", "Evidence payload is not valid base64.");
  }
  if (buffer.length === 0) {
    throw new EvidenceValidationError("EVIDENCE_INVALID", "Evidence payload is empty.");
  }
  if (buffer.length > MAX_BYTES) {
    throw new EvidenceValidationError("EVIDENCE_TOO_LARGE", `Evidence image exceeds the ${MAX_BYTES} byte cap.`);
  }
  return { mime, buffer };
}

// ---------------------------------------------------------------------------
// Manual EXIF/metadata stripping (see module header — no sharp dependency)
// ---------------------------------------------------------------------------

/** Strips APP1-APPF (EXIF/XMP/IPTC) + COM marker segments from a JPEG buffer. */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf; // not a JPEG — leave untouched
  const chunks: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) {
      // Malformed structure — bail out safely by keeping the remainder verbatim
      // rather than risking corrupting the image.
      chunks.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    let markerOffset = offset + 1;
    while (markerOffset < buf.length && buf[markerOffset] === 0xff) markerOffset++; // fill bytes
    const marker = buf[markerOffset];
    if (marker === undefined) {
      offset = buf.length;
      break;
    }
    // Markers with no payload/length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buf.subarray(offset, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }
    if (marker === 0xd9) {
      // EOI
      chunks.push(buf.subarray(offset, markerOffset + 1));
      offset = buf.length;
      break;
    }
    const lenOffset = markerOffset + 1;
    if (lenOffset + 2 > buf.length) {
      chunks.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    const length = buf.readUInt16BE(lenOffset);
    const segEnd = lenOffset + length;
    // Strip APP1-APPF (EXIF/XMP/IPTC/Photoshop IRB live here) and COM. Keep
    // APP0 (JFIF header — not personal metadata) and every other segment.
    const strip = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!strip) chunks.push(buf.subarray(offset, segEnd));
    if (marker === 0xda) {
      // Start Of Scan — everything after this is entropy-coded image data
      // (not segment-structured); copy the remainder verbatim and stop.
      chunks.push(buf.subarray(segEnd));
      offset = buf.length;
      break;
    }
    offset = segEnd;
  }
  return Buffer.concat(chunks);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_STRIP_CHUNK_TYPES = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/** Strips ancillary metadata chunks (eXIf/tEXt/zTXt/iTXt/tIME) from a PNG buffer. */
export function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;
  const chunks: Buffer[] = [buf.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 8 + length + 4; // length field + type + data + CRC
    if (chunkEnd > buf.length) {
      chunks.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    if (!PNG_STRIP_CHUNK_TYPES.has(type)) chunks.push(buf.subarray(offset, chunkEnd));
    offset = chunkEnd;
    if (type === "IEND") break;
  }
  return Buffer.concat(chunks);
}

const WEBP_STRIP_FOURCC = new Set(["EXIF", "XMP "]);

/** Strips the RIFF EXIF/XMP sub-chunks from a WEBP buffer. */
export function stripWebpMetadata(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return buf;
  }
  const body: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4); // RIFF chunk sizes are little-endian
    const padded = size + (size % 2);
    const chunkEnd = offset + 8 + padded;
    if (chunkEnd > buf.length) {
      body.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }
    if (!WEBP_STRIP_FOURCC.has(fourcc)) body.push(buf.subarray(offset, chunkEnd));
    offset = chunkEnd;
  }
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + payload.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, payload]);
}

function stripMetadata(buf: Buffer, mime: string): Buffer {
  if (mime === "image/jpeg") return stripJpegMetadata(buf);
  if (mime === "image/png") return stripPngMetadata(buf);
  if (mime === "image/webp") return stripWebpMetadata(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Signed-token helpers (LocalFsProvider) — stateless HMAC, no DB round-trip
// needed to verify a token at serve time.
// ---------------------------------------------------------------------------

const SIGNED_URL_TTL_SECONDS = 120;
const EVIDENCE_DIR = path.resolve("./.evidence");
/** Local evidence filenames are always `${randomUUID()}.<ext>` — validated on read to block path traversal. */
const LOCAL_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Namespaced off the app JWT secret so no new required env var is introduced. */
function evidenceTokenSecret(): string {
  return process.env.EVIDENCE_TOKEN_SECRET ?? `${loadConfig().jwtSecret}:discount-evidence`;
}

function signEvidenceToken(ref: string, expiresAtMs: number): string {
  const payloadB64 = base64url(Buffer.from(JSON.stringify({ ref, exp: expiresAtMs }), "utf8"));
  const sig = createHmac("sha256", evidenceTokenSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

export type EvidenceTokenResult = { ok: true; ref: string } | { ok: false; reason: "invalid" | "expired" };

/** Verifies a LocalFsProvider signed token: HMAC signature, then expiry. */
export function verifyEvidenceToken(token: string): EvidenceTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadB64, sigB64] = parts;
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const expectedSig = createHmac("sha256", evidenceTokenSecret()).update(payloadB64).digest();
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "invalid" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { ref?: unknown }).ref !== "string" ||
    typeof (payload as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }
  const { ref, exp } = payload as { ref: string; exp: number };
  if (Date.now() > exp) return { ok: false, reason: "expired" };
  return { ok: true, ref };
}

/** Reads a LocalFsProvider-stored file back for `GET /discount-evidence/:token`. Path-traversal-safe. */
export async function readLocalEvidenceFile(evidenceRef: string): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!evidenceRef.startsWith("local:")) return null;
  const filename = evidenceRef.slice("local:".length);
  if (!LOCAL_FILENAME_RE.test(filename)) return null;
  try {
    const buffer = await readFile(path.join(EVIDENCE_DIR, filename));
    const ext = filename.split(".").pop()!.toLowerCase();
    return { buffer, mime: EXT_MIME[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider interface + implementations
// ---------------------------------------------------------------------------

export interface EvidenceProvider {
  readonly kind: "cloudinary" | "local";
  /** Persists the (already metadata-stripped) buffer privately; returns an opaque `evidenceRef`. */
  store(buffer: Buffer, mime: string): Promise<string>;
  /** Mints a short-lived signed URL for a previously stored `evidenceRef`. Never permanent/public. */
  createSignedUrl(evidenceRef: string): Promise<{ url: string; expiresAt: Date }>;
}

/** Dev/test fallback — writes under `./.evidence/` (gitignored), serves via a signed token route. */
export class LocalFsProvider implements EvidenceProvider {
  readonly kind = "local" as const;

  async store(buffer: Buffer, mime: string): Promise<string> {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const ext = MIME_EXT[mime] ?? "bin";
    const filename = `${randomUUID()}.${ext}`;
    await writeFile(path.join(EVIDENCE_DIR, filename), buffer);
    return `local:${filename}`;
  }

  async createSignedUrl(evidenceRef: string): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
    const token = signEvidenceToken(evidenceRef, expiresAt.getTime());
    return { url: `/api/v1/discount-evidence/${token}`, expiresAt };
  }
}

/**
 * Cloudinary `type: "private"` upload (NEVER the public delivery type used by
 * ems/cloudinary.ts's uploadImage) + a Cloudinary-signed, time-limited
 * download URL per access via `private_download_url`.
 */
export class CloudinaryPrivateProvider implements EvidenceProvider {
  readonly kind = "cloudinary" as const;

  private configure(): void {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Missing Cloudinary configuration for private evidence storage.");
    }
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  }

  async store(buffer: Buffer, mime: string): Promise<string> {
    this.configure();
    const ext = MIME_EXT[mime] ?? "jpg";
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(dataUrl, {
      folder: "ck1/discount-evidence",
      resource_type: "image",
      type: "private", // private delivery — NOT the public `upload` type
    });
    return `cloudinary:${result.public_id}:${ext}`;
  }

  async createSignedUrl(evidenceRef: string): Promise<{ url: string; expiresAt: Date }> {
    this.configure();
    const rest = evidenceRef.slice("cloudinary:".length);
    const lastColon = rest.lastIndexOf(":");
    const publicId = lastColon === -1 ? rest : rest.slice(0, lastColon);
    const format = lastColon === -1 ? "jpg" : rest.slice(lastColon + 1);
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
    const url = cloudinary.utils.private_download_url(publicId, format, {
      resource_type: "image",
      type: "private",
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    });
    return { url, expiresAt };
  }
}

/** CLOUDINARY_* present => Cloudinary; otherwise the local dev/test fallback. */
export function selectEvidenceProvider(): EvidenceProvider {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) return new CloudinaryPrivateProvider();
  return new LocalFsProvider();
}

// ---------------------------------------------------------------------------
// Public service API
// ---------------------------------------------------------------------------

export interface StoreEvidenceInput {
  /** A `data:<mime>;base64,<data>` URI. */
  dataUrl: string;
}

export interface StoreEvidenceResult {
  /** Opaque, private storage key — NEVER a public/permanent URL. Persisted as `order_discount.evidence_ref`. */
  evidenceRef: string;
}

/** Validates, strips metadata from, and privately stores an evidence image. Throws {@link EvidenceValidationError}. */
export async function storeEvidence(input: StoreEvidenceInput): Promise<StoreEvidenceResult> {
  const { mime, buffer } = parseDataUrl(input.dataUrl);
  const stripped = stripMetadata(buffer, mime);
  const provider = selectEvidenceProvider();
  const evidenceRef = await provider.store(stripped, mime);
  return { evidenceRef };
}

export interface IssueSignedUrlParams {
  orderDiscountId: string;
  evidenceRef: string;
  accessedBy: string;
  purpose: string;
}

/**
 * Mints a short-lived signed URL for a stored evidence image AND, in the same
 * DB transaction, inserts the `discount_evidence_access_log` row — so a
 * signed URL is never handed out without a durable audit record of who
 * accessed it and why (spec §10: "every access is audited").
 */
export async function issueSignedUrl(db: DB, params: IssueSignedUrlParams): Promise<{ url: string; expiresAt: Date }> {
  const provider = selectEvidenceProvider();
  return db.transaction(async (tx) => {
    const { url, expiresAt } = await provider.createSignedUrl(params.evidenceRef);
    await tx.insert(discountEvidenceAccessLogs).values({
      orderDiscountId: params.orderDiscountId,
      accessedBy: params.accessedBy,
      purpose: params.purpose,
    });
    return { url, expiresAt };
  });
}

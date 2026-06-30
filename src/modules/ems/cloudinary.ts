/**
 * Cloudinary helper — CK1-EMS-005 E3
 *
 * Uploads a base64 data-URL to Cloudinary under the `ck1/attendance` folder
 * and returns the secure URL + public ID.
 *
 * MOCKABLE: exported as a named function so tests can `vi.mock('../ems/cloudinary.js')`
 * to avoid real network calls.
 *
 * Security: API secret is NEVER logged or returned to callers.
 */
import { v2 as cloudinary } from "cloudinary";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface UploadResult {
  url: string;
  publicId: string;
}

/**
 * Uploads a base64 data-URL to Cloudinary.
 *
 * @param dataUrl - A `data:<mime>;base64,<data>` string.
 * @returns       The Cloudinary secure_url and public_id.
 * @throws        ConfigError if required env vars are missing.
 * @throws        On Cloudinary upload failure.
 */
export async function uploadAttendancePhoto(dataUrl: string): Promise<UploadResult> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new ConfigError(
      "Missing Cloudinary configuration. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.",
    );
  }

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });

  const result = await cloudinary.uploader.upload(dataUrl, {
    folder: "ck1/attendance",
    resource_type: "image",
  });

  return { url: result.secure_url, publicId: result.public_id };
}

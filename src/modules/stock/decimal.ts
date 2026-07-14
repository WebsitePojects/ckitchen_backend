/** Exact fixed-scale decimal helpers for stock quantities.
 *
 * PostgreSQL remains the arithmetic authority, but the posting planner needs to
 * simulate before/after balances before it inserts immutable ledger lines.
 * BigInt prevents IEEE-754 drift. Scientific notation is intentionally rejected.
 */

export class DecimalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalValidationError";
  }
}

export function parseFixed(value: string | number, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    throw new DecimalValidationError(`Invalid decimal scale ${scale}.`);
  }
  const source = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(source);
  if (!match) throw new DecimalValidationError(`Invalid decimal value "${source}".`);

  const fraction = match[3] ?? "";
  if (fraction.length > scale) {
    const discarded = fraction.slice(scale);
    if (!/^0*$/.test(discarded)) {
      throw new DecimalValidationError(
        `Value "${source}" exceeds the supported ${scale}-decimal precision.`,
      );
    }
  }

  const whole = match[2]!;
  const padded = fraction.slice(0, scale).padEnd(scale, "0");
  const magnitude = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || "0");
  return match[1] === "-" ? -magnitude : magnitude;
}

export function formatFixed(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = magnitude / divisor;
  if (scale === 0) return `${negative ? "-" : ""}${whole}`;
  const fraction = (magnitude % divisor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function normalizeFixed(value: string | number, scale: number): string {
  return formatFixed(parseFixed(value, scale), scale);
}

export function multiplyFixedExact(
  left: string | number,
  leftScale: number,
  right: string | number,
  rightScale: number,
  outputScale: number,
): string {
  const product = parseFixed(left, leftScale) * parseFixed(right, rightScale);
  const productScale = leftScale + rightScale;
  if (productScale < outputScale) {
    return formatFixed(product * 10n ** BigInt(outputScale - productScale), outputScale);
  }
  const divisor = 10n ** BigInt(productScale - outputScale);
  if (product % divisor !== 0n) {
    throw new DecimalValidationError(
      `Product of ${left} and ${right} exceeds the supported ${outputScale}-decimal precision.`,
    );
  }
  return formatFixed(product / divisor, outputScale);
}

/**
 * Units of measure (D57). One catalogue for the whole system so a recipe, a delivery, a stock
 * count and an adjustment all mean the same thing by "250 g".
 *
 * Every ingredient is STOCKED in one unit (ingredient.unit). People may ENTER a quantity in
 * any unit of the same kind (mass, volume, count) or in a custom unit defined for that
 * ingredient ("1 sack = 25 kg"); the server converts it to the stock unit before anything is
 * stored or deducted. Conversion is exact decimal arithmetic (BigInt), rounded once, half-up,
 * to QUANTITY_SCALE.
 *
 * QUANTITY_SCALE = 6 is the system standard for stored quantities (matches the enterprise
 * stock tables): in kilograms that is one milligram, in litres one microlitre. Any number of
 * decimals may be typed; the stored value keeps 6.
 */

export const QUANTITY_SCALE = 6;

export type Dimension = "mass" | "volume" | "count";

export interface StandardUnit {
  code: string;
  label: string;
  dimension: Dimension;
  /** How many of the dimension's base unit (g, mL, pc) one of this unit is: an exact decimal. */
  base: string;
}

export const STANDARD_UNITS: readonly StandardUnit[] = [
  { code: "kg", label: "kilogram", dimension: "mass", base: "1000" },
  { code: "g", label: "gram", dimension: "mass", base: "1" },
  { code: "mg", label: "milligram", dimension: "mass", base: "0.001" },
  { code: "lb", label: "pound", dimension: "mass", base: "453.59237" },
  { code: "oz", label: "ounce", dimension: "mass", base: "28.349523125" },
  { code: "L", label: "litre", dimension: "volume", base: "1000" },
  { code: "mL", label: "millilitre", dimension: "volume", base: "1" },
  { code: "gal", label: "gallon (US)", dimension: "volume", base: "3785.411784" },
  { code: "cup", label: "cup (US)", dimension: "volume", base: "236.5882365" },
  { code: "tbsp", label: "tablespoon", dimension: "volume", base: "14.78676478125" },
  { code: "tsp", label: "teaspoon", dimension: "volume", base: "4.92892159375" },
  { code: "pc", label: "piece", dimension: "count", base: "1" },
  { code: "dozen", label: "dozen", dimension: "count", base: "12" },
];

const BY_CODE = new Map(STANDARD_UNITS.map((u) => [u.code, u]));

/** Spellings people actually type, lowercased -> catalogue code. */
const ALIASES: Record<string, string> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gm: "g", gms: "g", gr: "g", gram: "g", grams: "g",
  mg: "mg", milligram: "mg", milligrams: "mg",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  l: "L", lt: "L", ltr: "L", ltrs: "L", liter: "L", liters: "L", litre: "L", litres: "L",
  ml: "mL", milliliter: "mL", milliliters: "mL", millilitre: "mL", millilitres: "mL",
  gal: "gal", gallon: "gal", gallons: "gal",
  cup: "cup", cups: "cup",
  tbsp: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  pc: "pc", pcs: "pc", pce: "pc", piece: "pc", pieces: "pc", ea: "pc", each: "pc",
  dozen: "dozen", doz: "dozen", dz: "dozen",
};

/** The catalogue code for a typed unit ("Kgs" -> "kg"), or null if it is not a standard unit. */
export function standardUnitCode(unit: string): string | null {
  return ALIASES[unit.trim().toLowerCase()] ?? null;
}

export function standardUnit(code: string): StandardUnit | undefined {
  return BY_CODE.get(code);
}

/** Custom unit names: short, readable, no characters that break display or SQL text. */
export const CUSTOM_UNIT_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,23}$/u;

// ─── exact decimals ──────────────────────────────────────────────────────────

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantityError";
  }
}

interface Decimal {
  digits: bigint; // value = digits / 10^scale
  scale: number;
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$|^([+-]?)\.(\d+)$/;

/** Parses a plain decimal with ANY number of fraction digits. Rejects 1e3, NaN, "", etc. */
export function parseDecimal(value: string | number): Decimal {
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new QuantityError(`"${String(value)}" is not a number.`);
  const sign = m[1] ?? m[4] ?? "";
  const whole = m[2] ?? "0";
  const fraction = m[3] ?? m[5] ?? "";
  if (fraction.length > 30) throw new QuantityError(`"${String(value)}" has more than 30 decimals.`);
  const digits = BigInt(whole + fraction);
  return { digits: sign === "-" ? -digits : digits, scale: fraction.length };
}

function numberToPlain(value: number): string {
  if (!Number.isFinite(value)) throw new QuantityError(`${value} is not a number.`);
  // Up to 20 significant decimals without exponent notation.
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** round(numerator / denominator) half away from zero, as an integer. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** Formats digits/10^scale as a plain decimal with exactly `scale` places. */
export function formatScaled(digits: bigint, scale: number): string {
  const negative = digits < 0n;
  const magnitude = negative ? -digits : digits;
  const divisor = pow10(scale);
  const whole = magnitude / divisor;
  const fraction = scale === 0 ? "" : `.${(magnitude % divisor).toString().padStart(scale, "0")}`;
  return `${negative && magnitude !== 0n ? "-" : ""}${whole}${fraction}`;
}

/** value × multiplier ÷ divisor, exactly, rounded once to `outScale` decimals. */
export function scaleQuantity(value: string | number, multiplier: string, divisor: string, outScale = QUANTITY_SCALE): string {
  const v = parseDecimal(value);
  const m = parseDecimal(multiplier);
  const d = parseDecimal(divisor);
  if (d.digits === 0n) throw new QuantityError("Unit factor cannot be zero.");
  // (v.digits/10^vs) × (m.digits/10^ms) ÷ (d.digits/10^ds), expressed in units of 10^-outScale.
  const numerator = v.digits * m.digits * pow10(d.scale + outScale);
  const denominator = d.digits * pow10(v.scale + m.scale);
  return formatScaled(divideRounded(numerator, denominator), outScale);
}

/** Rounds a typed quantity to the storage standard (no unit change). */
export function normalizeQuantity(value: string | number): string {
  return scaleQuantity(value, "1", "1");
}

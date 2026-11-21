const scale = 1_000_000n;
const centsScale = 10_000_000_000n;
export const supplierDecimalPattern = /^(?:\d{1,12}(?:\.\d{1,6})?|\.\d{1,6})$/;

function scaled(decimal: string) {
  if (!supplierDecimalPattern.test(decimal)) return null;
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt((whole || "0") + fraction.padEnd(6, "0"));
}

function asDecimal(value: bigint) {
  const whole = value / scale;
  if (whole >= 1_000_000_000_000n) return null;
  const fraction = String(value % scale).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function supplierPurchaseFactor(buyUnit: string, stockUnit: string, raw?: string) {
  const sameUnit = buyUnit.trim().toLowerCase() === stockUnit.trim().toLowerCase();
  if (raw === undefined || raw === "") return sameUnit ? "1" : null;
  const factor = scaled(raw);
  if (factor === null || factor <= 0n || factor > scale * scale || (sameUnit && factor !== scale)) return null;
  return asDecimal(factor);
}

function roundPositive(numerator: bigint, denominator: bigint) {
  return (numerator * 2n + denominator) / (2n * denominator);
}

export function purchaseLineCents(quantity: string, unitCost: string): bigint | null {
  const qty = scaled(quantity);
  const rate = scaled(unitCost);
  return qty === null || rate === null ? null : roundPositive(qty * rate, centsScale);
}

export function supplierStockUnitRate(buyCost: string, rawFactor: string): string | null {
  const rate = scaled(buyCost);
  const factor = scaled(rawFactor);
  if (rate === null || !factor) return null;
  return asDecimal(roundPositive(rate * scale, factor));
}

export function supplierBuyQuantity(stockQuantity: string, rawFactor: string): string | null {
  const quantity = scaled(stockQuantity);
  const factor = scaled(rawFactor);
  if (!quantity || !factor || quantity * scale % factor !== 0n) return null;
  return asDecimal(quantity * scale / factor);
}

export function supplierStockQuantity(buyQuantity: string, rawFactor: string): string | null {
  const quantity = scaled(buyQuantity);
  const factor = scaled(rawFactor);
  if (!quantity || !factor || quantity * factor % scale !== 0n) return null;
  return asDecimal(quantity * factor / scale);
}

export function convertedSupplierLine(buyQuantity: string, buyCost: string, factor: string) {
  const quantity = supplierStockQuantity(buyQuantity, factor);
  const unitCost = supplierStockUnitRate(buyCost, factor);
  if (quantity === null || unitCost === null || purchaseLineCents(quantity, unitCost) !== purchaseLineCents(buyQuantity, buyCost)) return null;
  return { quantity, unitCost };
}

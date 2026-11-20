function fraction(value: number | string) {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, decimal = ""] = coefficient.split(".");
  const scale = decimal.length - Number(exponent);
  const numerator = BigInt(whole + decimal);
  return scale >= 0
    ? { numerator, denominator: 10n ** BigInt(scale) }
    : { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n };
}

function roundRatio(numerator: bigint, denominator: bigint) {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

type CostSlice = { quantity: number; unitCost: string };

function allocationCost(slices: readonly CostSlice[]) {
  let numerator = 0n;
  let denominator = 1n;
  for (const slice of slices) {
    const units = fraction(slice.quantity);
    const rate = fraction(slice.unitCost);
    const scale = units.denominator * rate.denominator;
    if (scale > denominator) {
      numerator *= scale / denominator;
      denominator = scale;
    }
    numerator += units.numerator * rate.numerator * (denominator / scale);
  }
  return { numerator, denominator };
}

export function allocatedIssueCents(slices: readonly CostSlice[]) {
  const cost = allocationCost(slices);
  return roundRatio(cost.numerator * 100n, cost.denominator);
}

export function allocatedIssueUnitCost(slices: readonly CostSlice[], quantity: number) {
  if (slices.length === 1) return slices[0].unitCost;
  const cost = allocationCost(slices);
  const units = fraction(quantity);
  const scale = 1_000_000_000_000n;
  const denominator = cost.denominator * units.numerator;
  const value = (cost.numerator * units.denominator * scale * 2n + denominator) / (denominator * 2n);
  return `${value / scale}.${(value % scale).toString().padStart(12, "0")}`;
}

export function issueChargeCents(quantity: number, unitCost: string) {
  const units = fraction(quantity);
  const rate = fraction(unitCost);
  return roundRatio(
    units.numerator * rate.numerator * 100n,
    units.denominator * rate.denominator,
  );
}

export function returnCreditCents({
  issuedQuantity,
  postedCents,
  issueUnitCost,
  creditedQuantity,
  creditedCents,
}: {
  issuedQuantity: number;
  postedCents: number;
  issueUnitCost: string | null;
  creditedQuantity: number;
  creditedCents: number;
}) {
  if (creditedQuantity >= issuedQuantity - 0.000001)
    return Math.max(0, postedCents - creditedCents);
  const returned = fraction(creditedQuantity);
  const issued = fraction(issuedQuantity);
  // Old issues stored only a rounded extended charge. Allocate that recorded charge by quantity.
  const target =
    issueUnitCost === null
      ? roundRatio(
          BigInt(postedCents) * returned.numerator * issued.denominator,
          returned.denominator * issued.numerator,
        )
      : issueChargeCents(creditedQuantity, issueUnitCost);
  return Math.max(0, Math.min(postedCents, target) - creditedCents);
}

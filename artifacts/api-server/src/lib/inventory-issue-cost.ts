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

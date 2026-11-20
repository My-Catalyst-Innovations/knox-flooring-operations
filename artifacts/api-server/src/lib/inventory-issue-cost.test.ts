import { describe, expect, it } from "vitest";
import { issueChargeCents, returnCreditCents } from "./inventory-issue-cost";

describe("stock issue and return cost", () => {
  it("applies the historical issue rate to returns and rounds exact decimal amounts", () => {
    expect(issueChargeCents(30, "48")).toBe(144000);
    expect(issueChargeCents(3, "0.335")).toBe(101);
    expect(issueChargeCents(3, "3.35e-1")).toBe(101);
    expect(
      returnCreditCents({
        issuedQuantity: 30,
        postedCents: 144000,
        issueUnitCost: "48",
        creditedQuantity: 2,
        creditedCents: 0,
      }),
    ).toBe(9600);
  });

  it("distributes rounding across partial credits and caps the final credit at the posted charge", () => {
    const issue = {
      issuedQuantity: 3,
      postedCents: 101,
      issueUnitCost: "0.335",
    };
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 1, creditedCents: 0 }),
    ).toBe(34);
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 2, creditedCents: 34 }),
    ).toBe(33);
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 3, creditedCents: 67 }),
    ).toBe(34);
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 3, creditedCents: 101 }),
    ).toBe(0);
  });

  it("allocates an older issue using its recorded extended charge", () => {
    const issue = { issuedQuantity: 3, postedCents: 100, issueUnitCost: null };
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 1, creditedCents: 0 }),
    ).toBe(33);
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 2, creditedCents: 33 }),
    ).toBe(34);
    expect(
      returnCreditCents({ ...issue, creditedQuantity: 3, creditedCents: 67 }),
    ).toBe(33);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";

let rules: typeof import("./physical-pieces");
beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture@127.0.0.1/physical_geometry_tests");
  try { rules = await import("./physical-pieces"); }
  finally { vi.unstubAllEnvs(); }
});

describe("physical piece geometry", () => {
  it("converts inches to square feet and preserves thousandth-inch measurements", () => {
    expect(rules.pieceArea(144, 240)).toBe(240);
    expect(rules.pieceArea(30.125, 38.25)).toBe(8.001953);
  });

  it("assigns rounding to the parent so cutting never adds or removes stock", () => {
    const piece = { widthInches: 50.125, lengthInches: 50.987, quantity: rules.pieceArea(50.125, 50.987) };
    const first = rules.pieceCut(piece, 15.23);
    const second = rules.pieceCut({ ...piece, lengthInches: first.remainingLength, quantity: first.remainingQuantity }, 7.123);
    expect(first.remainingLength).toBe(35.757);
    expect(second.remainingLength).toBe(28.634);
    expect(first.childQuantity + second.childQuantity + second.remainingQuantity).toBeCloseTo(piece.quantity, 9);
    expect(() => rules.pieceCut(piece, piece.lengthInches)).toThrow();
  });

  it("returns only the measured part or exactly the issued area for a full return", () => {
    const piece = { widthInches: 120, lengthInches: 30, quantity: 24.999999 };
    expect(rules.pieceReturnQuantity(piece, 30)).toBe(24.999999);
    expect(rules.pieceReturnQuantity(piece, 12)).toBe(10);
    expect(() => rules.pieceReturnQuantity(piece, 30.001)).toThrow();
  });
});

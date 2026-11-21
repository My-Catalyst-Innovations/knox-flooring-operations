import { expect, it } from "vitest";
import {
  code128,
  locationBarcode,
  pieceBarcode,
  readLocationBarcode,
} from "./warehouse-labels";

it("encodes the known Code 128 set C start, checksum and stop with a quiet zone", () => {
  const barcode = code128("123456")!;
  // Start C, 12, 34, 56, then (105 + 12 + 2*34 + 3*56) mod 103 = 44.
  expect(barcode.modules).toBe(
    "11010011100" +
      "10110011100" +
      "10001011000" +
      "11100010110" +
      "10001101110" +
      "1100011101011",
  );
  expect(barcode.width).toBe(barcode.modules.length + 24);
  expect(barcode.path).toMatch(/^M12 0/);
  expect(code128("\n")).toBeNull();
});

it("round-trips stable warehouse and bin IDs, and preserves a piece's full label", () => {
  expect(
    readLocationBarcode(
      ` ${locationBarcode({ kind: "warehouse", id: "warehouse-1" })}\r\n`,
    ),
  ).toEqual({ kind: "warehouse", id: "warehouse-1" });
  expect(
    readLocationBarcode(locationBarcode({ kind: "bin", id: "bin-42" })),
  ).toEqual({ kind: "bin", id: "bin-42" });
  expect(readLocationBarcode(pieceBarcode("Roll 01/A_5"))).toBeNull();
  expect(code128(pieceBarcode(`A${"b".repeat(79)}`))).not.toBeNull();
});

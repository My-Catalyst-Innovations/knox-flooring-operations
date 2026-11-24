import { describe, expect, it } from "vitest";
import {
  legacyOriginalKind,
  legacyOriginalMaxBytes,
  validateLegacyOriginal,
} from "./legacy-history-files";
const pdf = Buffer.from("%PDF-1.7\nOriginal source\n%%EOF");
describe("private historical original file limits", () => {
  it("accepts supported original signatures with matching simple names", () => {
    expect(validateLegacyOriginal("Original invoice.pdf", pdf)).toBe("pdf");
    expect(
      validateLegacyOriginal("Photo.jpeg", Buffer.from([255, 216, 255, 217])),
    ).toBe("jpeg");
  });
  it.each([
    "../Original.pdf",
    "folder\\Original.pdf",
    "Original\nInjected.pdf",
  ])("refuses unsafe metadata filenames", (name) =>
    expect(() => validateLegacyOriginal(name, pdf)).toThrow(/filename/),
  );
  it("refuses extension mismatch and unsupported executable/office/archive content", () => {
    expect(() => validateLegacyOriginal("Invoice.jpg", pdf)).toThrow(
      /extension/,
    );
    for (const content of [
      "<svg/>",
      "<html>untrusted</html>",
      "PK\u0003\u0004macro document",
      "%PDF-1.7 incomplete",
    ]) {
      expect(() => legacyOriginalKind(Buffer.from(content))).toThrow(
        /supported|Choose/,
      );
    }
  });
  it("caps private originals before any storage operation", () => {
    expect(() =>
      legacyOriginalKind(Buffer.alloc(legacyOriginalMaxBytes + 1)),
    ).toThrow(/15 MiB/);
    expect(() => legacyOriginalKind(Buffer.alloc(0))).toThrow(/15 MiB/);
  });
});

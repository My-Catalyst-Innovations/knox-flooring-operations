import { expect, it } from "vitest";
import { readSupplierCsv } from "./supplier-contacts";
it("preserves exact uploaded UTF8 bytes including BOM and CRLF", async () => {
  const source = "\uFEFFsource_id,name\r\n0001,Supply\r\n",
    bytes = new TextEncoder().encode(source),
    file = new File([bytes], "Original.csv");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  expect(await readSupplierCsv(file)).toBe(source);
});
it("rejects invalid UTF8 rather than replacing source bytes", async () => {
  const file = new File([new Uint8Array([255])], "Original.csv");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new Uint8Array([255]).buffer,
  });
  await expect(readSupplierCsv(file)).rejects.toThrow(/UTF-8/);
});
it("refuses zero and oversized source files before reading", async () => {
  await expect(readSupplierCsv(new File([], "Empty.csv"))).rejects.toThrow(
    /1 MiB/,
  );
  const file = new File(["x"], "Large.csv");
  Object.defineProperty(file, "size", { value: 1048577 });
  await expect(readSupplierCsv(file)).rejects.toThrow(/1 MiB/);
});

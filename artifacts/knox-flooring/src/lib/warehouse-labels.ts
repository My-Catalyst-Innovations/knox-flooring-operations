import JsBarcode from "jsbarcode";

export const barcodeModuleMillimeters = 0.25;
const quietZone = 12;
const height = 68;

export function code128(value: string) {
  if (!/^[\x20-\x7e]{1,96}$/.test(value)) return null;
  const encoded: { encodings?: { data: string }[] } = {};
  JsBarcode(encoded, value, { format: "CODE128", displayValue: false });
  const modules = encoded.encodings?.map(({ data }) => data).join("") ?? "";
  if (!modules || /[^01]/.test(modules)) return null;

  const bars = Array.from(
    modules.matchAll(/1+/g),
    ({ index, 0: run }) =>
      `M${index + quietZone} 0h${run.length}v${height}h-${run.length}Z`,
  );
  return {
    width: modules.length + 2 * quietZone,
    height,
    path: bars.join(""),
    modules,
  };
}

type LocationLabel = { kind: "warehouse" | "bin"; id: string };

export function locationBarcode({ kind, id }: LocationLabel) {
  return `${kind === "warehouse" ? "WH" : "BIN"}:${id}`;
}

export function readLocationBarcode(value: string): LocationLabel | null {
  const match = /^(WH|BIN):([a-zA-Z0-9._-]{1,80})$/i.exec(value.trim());
  return match
    ? {
        kind: match[1].toUpperCase() === "WH" ? "warehouse" : "bin",
        id: match[2],
      }
    : null;
}

export const pieceBarcode = (label: string) => `PIECE:${label}`;

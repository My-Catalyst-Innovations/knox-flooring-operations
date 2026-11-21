import { AnnotationMode, getDocument, GlobalWorkerOptions, Util, type PDFPageProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ocrWorkerUrl from "tesseract.js/dist/worker.min.js?url";
import ocrCoreUrl from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import englishModelUrl from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import { previewBillDocument, type InvoicePage, type InvoiceWord } from "./vendor-bill-document";
import type Tesseract from "tesseract.js";

export const documentBillMaxBytes = 10 * 1024 * 1024;
const maxPages = 8;
const maxImagePixels = 20_000_000;
const targetPixels = 5_000_000;
const maxWords = 3_000;

function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function checkWords(words: InvoiceWord[]) {
  if (words.length > maxWords) throw new Error("A page has too much text for invoice import. Use the bill-line CSV or manual entry.");
  return words;
}

async function selectableWords(page: PDFPageProxy, signal: AbortSignal): Promise<InvoiceWord[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await untilAbort(page.getTextContent(), signal);
  return checkWords(content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [a, b, _c, _d, left, baseline] = Util.transform(viewport.transform, item.transform);
    if (Math.abs(b) > Math.abs(a) * 0.1 || a <= 0 || !item.width) return [];
    const height = Math.max(1, item.height);
    return [{ text: item.str.trim(), left, right: left + item.width, centerY: baseline - height / 2, height }];
  }));
}

export function wordsFromOcr(tsv: string): InvoiceWord[] {
  return checkWords(tsv.split(/\r?\n/).flatMap((row) => {
    const fields = row.split("\t");
    const text = fields.slice(11).join("\t").trim();
    if (fields[0] !== "5" || !text) return [];
    const [left, top, width, height, confidence] = fields.slice(6, 11).map(Number);
    if (![left, top, width, height, confidence].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{ text, left, right: left + width, centerY: top + height / 2, height, confidence }];
  }));
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not prepare the scan for OCR. Use CSV or manual entry.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

async function scanImage(file: File, signal: AbortSignal) {
  const image = await untilAbort(createImageBitmap(file), signal);
  try {
    const pixels = image.width * image.height;
    if (pixels > maxImagePixels) throw new Error("Choose a scan under 20 megapixels, or use CSV or manual entry.");
    const scale = Math.min(1, Math.sqrt(targetPixels / pixels));
    const { canvas, context } = makeCanvas(image.width * scale, image.height * scale);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    image.close();
  }
}

async function rasterPage(page: PDFPageProxy, signal: AbortSignal) {
  const pageSize = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.sqrt(targetPixels / (pageSize.width * pageSize.height)));
  const viewport = page.getViewport({ scale });
  const { canvas, context } = makeCanvas(viewport.width, viewport.height);
  const drawing = page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.DISABLE, background: "white" });
  const cancel = () => drawing.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await untilAbort(drawing.promise, signal);
    return canvas;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function inputType(bytes: Uint8Array) {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => byte === bytes[index])) return "image";
  throw new Error("Choose a PDF, PNG, or JPEG invoice.");
}

export async function readBillDocument(file: File, options: { signal: AbortSignal; status: (message: string) => void }) {
  if (!file.size || file.size > documentBillMaxBytes) throw new Error("Choose a PDF or scan up to 10 MB.");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  const type = inputType(new Uint8Array(await untilAbort(file.slice(0, 8).arrayBuffer(), signal)));
  let ocr: Tesseract.Worker | undefined;
  let pdf: ReturnType<typeof getDocument> | undefined;

  async function ocrPage(canvas: HTMLCanvasElement, page: number): Promise<InvoicePage> {
    try {
      signal.throwIfAborted();
      options.status(`Reading scan on page ${page}…`);
      if (!ocr) {
        const module = (await untilAbort(import("tesseract.js"), signal)).default;
        // A bundled scalar LSTM engine works on devices without WASM SIMD.
        const langPath = new URL(".", new URL(englishModelUrl, location.href)).href.replace(/\/$/, "");
        const startup = module.createWorker("eng", module.OEM.LSTM_ONLY, {
          workerPath: ocrWorkerUrl, corePath: ocrCoreUrl, langPath, workerBlobURL: false, cacheMethod: "none", errorHandler: () => {},
        });
        void startup.then((worker) => { if (signal.aborted) void worker.terminate().catch(() => {}); }).catch(() => {});
        ocr = await untilAbort(startup, signal);
      }
      const result = await untilAbort(ocr.recognize(canvas, {}, { tsv: true }), signal);
      return { page, words: wordsFromOcr(result.data.tsv ?? ""), ocr: true };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  try {
    if (type === "image") return previewBillDocument([await ocrPage(await scanImage(file, signal), 1)]);
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    pdf = getDocument({
      data: new Uint8Array(await untilAbort(file.arrayBuffer(), signal)), stopAtErrors: true, enableXfa: false,
      useWasm: false, useWorkerFetch: false, maxImageSize: maxImagePixels, canvasMaxAreaInBytes: maxImagePixels * 4,
    });
    const source = await untilAbort(pdf.promise, signal);
    if (source.numPages < 1 || source.numPages > maxPages) throw new Error(`Choose a PDF of up to ${maxPages} pages.`);
    const pages: InvoicePage[] = [];
    for (let number = 1; number <= source.numPages; number++) {
      options.status(`Reading PDF page ${number} of ${source.numPages}…`);
      const page = await untilAbort(source.getPage(number), signal);
      try {
        const words = await selectableWords(page, signal);
        // A sparse text layer may contain a page number over a scanned page.
        pages.push(words.length >= 4
          ? { page: number, words, ocr: false }
          : await ocrPage(await rasterPage(page, signal), number));
      } finally {
        page.cleanup();
      }
    }
    return previewBillDocument(pages);
  } catch (error) {
    if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new Error("Document reading took too long. Try a shorter PDF or use CSV or manual entry.");
    }
    if (error instanceof Error && ["PasswordException", "InvalidPDFException"].includes(error.name)) {
      throw new Error("This PDF is locked or unreadable. Choose an accessible copy or use CSV or manual entry.");
    }
    throw error;
  } finally {
    await Promise.allSettled([ocr?.terminate(), pdf?.destroy()]);
  }
}

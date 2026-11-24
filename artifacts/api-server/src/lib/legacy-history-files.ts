import { DomainError } from "./operations-rules";
export const legacyOriginalMaxBytes = 15 * 1024 * 1024;
/** Original files are downloaded, never rendered or evaluated by the archive. */
export function legacyOriginalKind(
  bytes: Buffer,
): "pdf" | "jpeg" | "png" | "webp" | "gif" {
  if (bytes.length < 1 || bytes.length > legacyOriginalMaxBytes)
    throw new DomainError(413, "Choose an original file up to 15 MiB.");
  if (
    bytes.length >= 14 &&
    bytes.toString("ascii", 0, 5) === "%PDF-" &&
    bytes
      .subarray(Math.max(0, bytes.length - 1024))
      .includes(Buffer.from("%%EOF"))
  )
    return "pdf";
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  )
    return "jpeg";
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  if (
    bytes.length >= 13 &&
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
  )
    return "gif";
  throw new DomainError(
    415,
    "Choose an original PDF, JPEG, PNG, WebP or GIF file. Other formats are not supported by this archive.",
  );
}
export function validateLegacyOriginal(name: string, bytes: Buffer) {
  if (!name || name.length > 255 || /[\p{Cc}\\/]/u.test(name))
    throw new DomainError(
      400,
      "Use a simple original filename up to 255 characters.",
    );
  const kind = legacyOriginalKind(bytes),
    suffix = name.split(".").at(-1)?.toLowerCase();
  if (
    !(kind === "jpeg"
      ? ["jpg", "jpeg"].includes(suffix ?? "")
      : suffix === kind)
  )
    throw new DomainError(
      415,
      "The original filename extension must match its supported file content.",
    );
  return kind;
}

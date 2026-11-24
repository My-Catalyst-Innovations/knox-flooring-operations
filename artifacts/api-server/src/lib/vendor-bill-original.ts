import { DomainError } from "./operations-rules";
import {
  legacyOriginalKind,
  validateLegacyOriginal,
} from "./legacy-history-files";
export const vendorBillOriginalMaxBytes = 10 * 1024 * 1024;
export function vendorBillOriginalKind(bytes: Buffer) {
  if (!bytes.length || bytes.length > vendorBillOriginalMaxBytes)
    throw new DomainError(413, "Choose a supplier bill original up to 10 MiB.");
  const type = legacyOriginalKind(bytes);
  if (!["pdf", "jpeg", "png"].includes(type))
    throw new DomainError(
      415,
      "Choose an original supplier PDF, JPEG or PNG file.",
    );
  return type;
}
export function validateVendorBillOriginal(name: string, bytes: Buffer) {
  vendorBillOriginalKind(bytes);
  return validateLegacyOriginal(name, bytes);
}

import { cutoverHash } from "./cutover-hash";
/** Transport results can be appended after posting; the approved source cannot change. */
export function immutableVendorBillSource(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const {
    postedId: _postedId,
    reconciledExisting: _existing,
    ...source
  } = payload;
  return source;
}
export const vendorBillSourceFingerprint = (payload: Record<string, unknown>) =>
  cutoverHash(immutableVendorBillSource(payload));

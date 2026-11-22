import type {
  CommunicationInsert,
  CommunicationRow,
  CommunicationStatus,
} from "@workspace/db";

export type CommunicationOutcome = Pick<
  CommunicationInsert,
  "status" | "providerMessageId" | "fromAddress" | "errorMessage"
>;

const rank: Record<CommunicationStatus, number> = {
  unknown: 0,
  queued: 1,
  sent: 2,
  failed: 3,
  delivered: 4,
  received: 5,
  captured: 5,
};

export function isPendingSignalWireMessage(value?: string | null) {
  return (
    value?.startsWith("signalwire:") === true && value.endsWith(":pending")
  );
}

export function reconcileCommunicationOutcome(
  previous: CommunicationRow,
  next: CommunicationOutcome,
) {
  const confirmed =
    previous.providerMessageId &&
    !isPendingSignalWireMessage(previous.providerMessageId);
  if (
    confirmed &&
    next.providerMessageId &&
    previous.providerMessageId !== next.providerMessageId
  )
    return {};

  const previousIsStronger = rank[previous.status] > rank[next.status];
  const keepStatus =
    previousIsStronger && (confirmed || previous.status !== "queued");
  const keepError =
    keepStatus ||
    (confirmed &&
      previous.status === "failed" &&
      next.status === "failed" &&
      previous.errorMessage);
  return {
    status: keepStatus ? previous.status : next.status,
    providerMessageId: confirmed
      ? previous.providerMessageId
      : (next.providerMessageId ?? previous.providerMessageId),
    fromAddress: confirmed
      ? previous.fromAddress || next.fromAddress
      : (next.fromAddress ?? previous.fromAddress),
    errorMessage: keepError
      ? previous.errorMessage
      : (next.errorMessage ??
        (next.status === previous.status ? previous.errorMessage : null)),
  };
}

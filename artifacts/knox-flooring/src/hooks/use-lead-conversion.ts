import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListJobsQueryKey,
  getListLeadsQueryKey,
  useConvertLead,
} from "@workspace/api-client-react";
import type { Lead } from "@/lib/types";

export function useLeadConversion() {
  const queryClient = useQueryClient();
  const { mutateAsync } = useConvertLead();
  const inFlight = useRef(new Set<string>());
  const [pendingLeadIds, setPendingLeadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  async function convertLeadToJob({
    id,
    revision,
  }: Pick<Lead, "id" | "revision">) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setPendingLeadIds(new Set(inFlight.current));
    try {
      const job = await mutateAsync({ id, data: { revision } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() }),
      ]);
      return job;
    } finally {
      inFlight.current.delete(id);
      setPendingLeadIds(new Set(inFlight.current));
    }
  }

  return { convertLeadToJob, pendingLeadIds };
}

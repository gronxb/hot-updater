import { useQuery } from "@tanstack/react-query";

import { getCapabilities } from "./api-rpc";

export const capabilitiesQueryKey = ["console-capabilities"] as const;

export function useCapabilitiesQuery() {
  return useQuery({
    queryKey: capabilitiesQueryKey,
    queryFn: () => getCapabilities(),
    staleTime: Infinity,
  });
}

import { useQuery } from "@tanstack/react-query";

import { getBundleSigningInspectionRpc } from "./bundle-signing-rpc";

export const bundleSigningQueryKey = ["bundle-signing"] as const;

export const getBundleSigningInspectionQueryOptions = () => ({
  queryFn: () => getBundleSigningInspectionRpc(),
  queryKey: bundleSigningQueryKey,
  staleTime: 30_000,
});

export const useBundleSigningInspectionQuery = () =>
  useQuery(getBundleSigningInspectionQueryOptions());

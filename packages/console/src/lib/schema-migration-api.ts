import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { getSchemaMigrationRpc } from "./schema-migration-rpc";

export const schemaMigrationQueryKey = ["schema-migration"] as const;

export const schemaMigrationQueryOptions = () =>
  queryOptions({
    queryKey: schemaMigrationQueryKey,
    queryFn: () => getSchemaMigrationRpc(),
    retry: false,
  });

const isSchemaQuery = (queryKey: readonly unknown[]) =>
  queryKey[0] === schemaMigrationQueryKey[0];

/**
 * The schema fence's refusal of the console's database, asked for once any
 * page's read fails, so a healthy console reads nothing more. `retry` asks
 * again, and once the fence passes, reads the failed pages again.
 */
export const useSchemaMigration = () => {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  const failing = useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () =>
      cache
        .getAll()
        .some(
          ({ queryKey, state }) =>
            !isSchemaQuery(queryKey) && state.fetchFailureCount > 0,
        ),
    () => false,
  );
  const { data } = useQuery({
    ...schemaMigrationQueryOptions(),
    enabled: failing,
  });
  const retry = useCallback(async () => {
    const status = await queryClient.fetchQuery({
      ...schemaMigrationQueryOptions(),
      staleTime: 0,
    });
    if (status !== null) return;
    await queryClient.resetQueries({
      predicate: ({ queryKey, state }) =>
        !isSchemaQuery(queryKey) &&
        (state.fetchFailureCount > 0 || state.status === "error"),
    });
  }, [queryClient]);
  return { status: data ?? null, retry };
};

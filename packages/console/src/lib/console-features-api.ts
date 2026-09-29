import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";

import { type ConsoleFeature, consoleFeatures } from "./console-features";
import { getConsoleFeaturesRpc } from "./console-features-rpc";

export const consoleFeaturesQueryKey = ["console", "features"] as const;

export const consoleFeaturesQueryOptions = () =>
  queryOptions({
    queryKey: consoleFeaturesQueryKey,
    queryFn: () => getConsoleFeaturesRpc(),
    // A server's plugins change only when it restarts: one read serves a visit.
    staleTime: Infinity,
  });

/** The features the console serves; the authorized layout loads them first. */
export const useConsoleFeatures = () => useQuery(consoleFeaturesQueryOptions());

/** Whether `feature` is on; false until the features load. */
export const useConsoleFeature = (feature: ConsoleFeature): boolean =>
  useConsoleFeatures().data?.features[feature] === true;

/** A feature route's not-found data: the feature its guard found off. */
type ConsoleFeatureNotFoundData = { readonly feature: ConsoleFeature };

/** The feature in a route's not-found data, when a feature guard threw it. */
export const notFoundFeature = (data: unknown): ConsoleFeature | undefined => {
  const feature =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "feature")
      : undefined;
  return typeof feature === "string" && Object.hasOwn(consoleFeatures, feature)
    ? (feature as ConsoleFeature)
    : undefined;
};

/**
 * A feature route's `beforeLoad`: not found, naming the feature, when the
 * console does not serve it. A failed features read lets the route load: the
 * root layout answers a visitor it does not authorize, and the route's own
 * reads report any other failure. The failure leaves the cache, which a
 * server render sends to the browser: a refused visitor's failure is the 401
 * or 403 Response, which the render cannot serialize.
 */
export const requireConsoleFeature = async (
  queryClient: QueryClient,
  feature: ConsoleFeature,
): Promise<void> => {
  const featureSet = await queryClient
    .ensureQueryData(consoleFeaturesQueryOptions())
    .catch(() => {
      queryClient.removeQueries({
        queryKey: consoleFeaturesQueryKey,
        exact: true,
      });
      return undefined;
    });
  if (featureSet !== undefined && !featureSet.features[feature]) {
    throw notFound({
      data: { feature } satisfies ConsoleFeatureNotFoundData,
    });
  }
};

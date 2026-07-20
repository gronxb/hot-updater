import { createStandaloneHttp } from "./standaloneHttp";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

type RemoteAnalyticsCapability =
  | { readonly analytics: false }
  | { readonly analytics: true; readonly mode: "dedicated" }
  | {
      readonly analytics: true;
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    };

export const internalAnalyticsCapabilityProbe = Symbol.for(
  "@hot-updater/internal/analytics-capability-probe",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAnalyticsCapability = (
  value: unknown,
): value is RemoteAnalyticsCapability => {
  if (!isRecord(value) || typeof value.analytics !== "boolean") return false;
  if (!value.analytics) return true;
  if (value.mode === "dedicated") return true;
  return (
    value.mode === "bounded" &&
    typeof value.maxMatchingRows === "number" &&
    Number.isFinite(value.maxMatchingRows) &&
    value.maxMatchingRows > 0
  );
};

const isVersionResponse = (
  value: unknown,
): value is {
  readonly version: string;
  readonly capabilities?: RemoteAnalyticsCapability;
} =>
  isRecord(value) &&
  typeof value.version === "string" &&
  (value.capabilities === undefined ||
    isAnalyticsCapability(value.capabilities));

export const createAnalyticsCapabilityProbe = (
  config: StandaloneRepositoryConfig,
) => {
  const http = createStandaloneHttp(config);
  return async (): Promise<RemoteAnalyticsCapability> => {
    const response = await http.load(
      { path: "/version" },
      {},
      isVersionResponse,
      "Invalid server version response.",
    );
    return response.capabilities ?? { analytics: false };
  };
};

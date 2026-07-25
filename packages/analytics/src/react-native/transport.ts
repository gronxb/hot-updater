import type { CreateBundleEventRequest } from "../domain";

export type ReactNativeAnalyticsBaseURL =
  | string
  | (() => string | Promise<string>);

export interface ReactNativeAnalyticsTransport {
  send(event: CreateBundleEventRequest): Promise<void>;
}

type DefaultTransportOptions = {
  readonly baseURL: ReactNativeAnalyticsBaseURL;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly requestTimeout?: number;
  readonly sdkVersion: string;
};

class AnalyticsBaseURLError extends Error {
  readonly name = "AnalyticsBaseURLError";
}

class AnalyticsResponseError extends Error {
  readonly name = "AnalyticsResponseError";

  constructor(readonly status: number) {
    super(`Expected HTTP 204 from /events, received ${status}`);
  }
}

const DEFAULT_REQUEST_TIMEOUT = 5_000;

export const createDefaultTransport = (
  options: DefaultTransportOptions,
): ReactNativeAnalyticsTransport => {
  const configuredHeaders = new Headers(options.requestHeaders);

  return {
    async send(event) {
      const baseURL =
        typeof options.baseURL === "function"
          ? await options.baseURL()
          : options.baseURL;

      if (baseURL.length === 0) {
        throw new AnalyticsBaseURLError(
          "baseURL resolver must return a non-empty string",
        );
      }

      const headers = new Headers(configuredHeaders);
      headers.set("Content-Type", "application/json");
      headers.set("Hot-Updater-SDK-Version", options.sdkVersion);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      );

      try {
        const response = await fetch(`${baseURL.replace(/\/+$/, "")}/events`, {
          body: JSON.stringify(event),
          headers,
          method: "POST",
          signal: controller.signal,
        });

        if (response.status !== 204) {
          throw new AnalyticsResponseError(response.status);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
};

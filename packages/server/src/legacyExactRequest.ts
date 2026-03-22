import { NIL_UUID } from "@hot-updater/core";
import { normalizeBasePath } from "./route";

export interface RewriteLegacyExactRequestOptions {
  basePath: string;
  headers?: Headers;
  request: Request;
}

const createJsonResponse = (body: Record<string, string>, status: number) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

const getHeader = (headers: Headers, name: string) => {
  return headers.get(name);
};

const encodeSegment = (value: string) => encodeURIComponent(value);

export function rewriteLegacyExactRequestToCanonical(
  options: RewriteLegacyExactRequestOptions,
): Request | Response {
  const headers = options.headers ?? options.request.headers;
  const bundleId = getHeader(headers, "x-bundle-id");
  const platform = getHeader(headers, "x-app-platform");
  const appVersion = getHeader(headers, "x-app-version");
  const fingerprintHash = getHeader(headers, "x-fingerprint-hash");
  const minBundleId = getHeader(headers, "x-min-bundle-id") ?? NIL_UUID;
  const channel = getHeader(headers, "x-channel") ?? "production";
  const cohort = getHeader(headers, "x-cohort");

  if (!bundleId || !platform) {
    return createJsonResponse(
      {
        error: "Missing required headers (x-app-platform, x-bundle-id).",
      },
      400,
    );
  }

  if (!appVersion && !fingerprintHash) {
    return createJsonResponse(
      {
        error:
          "Missing required headers (x-app-version or x-fingerprint-hash).",
      },
      400,
    );
  }

  const normalizedBasePath = normalizeBasePath(options.basePath);
  const strategySegment = fingerprintHash ? "fingerprint" : "app-version";
  const strategyValue = fingerprintHash ?? appVersion;

  const pathSegments = [
    normalizedBasePath,
    strategySegment,
    encodeSegment(platform),
    encodeSegment(strategyValue as string),
    encodeSegment(channel),
    encodeSegment(minBundleId),
    encodeSegment(bundleId),
    ...(cohort ? [encodeSegment(cohort)] : []),
  ].filter(Boolean);

  const url = new URL(options.request.url);
  url.pathname =
    normalizedBasePath === "/"
      ? `/${pathSegments.slice(1).join("/")}`
      : pathSegments.join("/");

  return new Request(url, options.request);
}

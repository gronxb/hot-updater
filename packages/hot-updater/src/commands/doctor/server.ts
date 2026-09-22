import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

class VerificationError extends Error {}

const requireCheck: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new VerificationError(message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
// Match the native client's releaseCatalogCache.ts wire validation.
const maxCatalogWireBytes = 2 * 256 * 1024 + 4 * 1024;
const isUuidV7 = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw new VerificationError("Server did not return valid JSON.");
  }
};

const isDescriptor = (value: unknown) =>
  isObject(value) &&
  isUuidV7(value["releaseId"]) &&
  ((value["kind"] === "BUNDLE" && typeof value["bundleId"] === "string") ||
    (value["kind"] === "EMBEDDED" && value["bundleId"] === null)) &&
  Number.isSafeInteger(value["rolloutCohortCount"]) &&
  typeof value["rolloutCohortCount"] === "number" &&
  value["rolloutCohortCount"] >= 0 &&
  value["rolloutCohortCount"] <= 1000 &&
  Array.isArray(value["targetCohorts"]) &&
  value["targetCohorts"].length <= 100 &&
  value["targetCohorts"].every((cohort) => typeof cohort === "string") &&
  typeof value["shouldForceUpdate"] === "boolean" &&
  (value["message"] === null || typeof value["message"] === "string");

export interface ServerVerificationOptions {
  cwd: string;
  infraDir: string;
  baseUrl?: string;
  platform?: string;
  channel?: string;
  appVersion?: string;
  fingerprint?: string;
  serverVersion: string;
  infrastructureGeneration: number;
  fetch?: typeof fetch;
}

export type ServerVerification =
  | {
      status: "verified";
      checks: {
        version: "matches-manifest";
        anonymousCatalog: 401;
        authenticatedCatalog: number;
        catalog: "empty" | "available";
      };
    }
  | {
      status: "failed";
      check:
        | "inputs"
        | "version"
        | "anonymous-catalog"
        | "authenticated-catalog";
      error: string;
    };

export async function verifyServer(
  options: ServerVerificationOptions,
): Promise<ServerVerification> {
  const request = async (url: URL, apiKey?: string) => {
    const response = await (options.fetch ?? fetch)(url, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    let body = "";
    let size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      requireCheck(
        size <= maxCatalogWireBytes,
        "Server response exceeds the probe limit.",
      );
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    return { response, body };
  };

  let check:
    | "inputs"
    | "version"
    | "anonymous-catalog"
    | "authenticated-catalog" = "inputs";
  try {
    const values = {
      "base-url": options.baseUrl,
      platform: options.platform,
      channel: options.channel,
      "app-version": options.appVersion,
      fingerprint: options.fingerprint,
    };
    requireCheck(
      isText(values["base-url"]) &&
        (values.platform === "ios" || values.platform === "android") &&
        isText(values.channel) &&
        isText(values["app-version"] ?? values.fingerprint) &&
        (values["app-version"] === undefined) !==
          (values.fingerprint === undefined),
      "Provide --base-url, --platform, --channel and exactly one of --app-version or --fingerprint.",
    );
    const baseUrl = new URL(values["base-url"]);
    requireCheck(
      ["http:", "https:"].includes(baseUrl.protocol) &&
        !baseUrl.username &&
        !baseUrl.password &&
        !baseUrl.search &&
        !baseUrl.hash,
      "Use an HTTP(S) server base URL without credentials, query or fragment.",
    );
    const environmentText = await readFile(
      path.join(options.cwd, ".env.hotupdater"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const environment = parseEnv(environmentText.replace(/^\uFEFF/, ""));
    const localKey = await readFile(
      path.join(options.infraDir, "app/api-key.local"),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const savedKey = localKey.trim();
    const environmentKey = (
      process.env["HOT_UPDATER_API_KEY"] ?? environment["HOT_UPDATER_API_KEY"]
    )?.trim();
    requireCheck(
      !savedKey || !environmentKey || savedKey === environmentKey,
      "Saved client keys differ. Resolve the target key before verification.",
    );
    const apiKey = environmentKey || savedKey;
    requireCheck(apiKey, "Store the client key locally before verification.");
    const strategy = values["app-version"] ? "app-version" : "fingerprint";
    const target = values["app-version"] || values.fingerprint;
    requireCheck(isText(target), "An update target is required.");
    requireCheck(
      target !== "." &&
        target !== ".." &&
        (strategy !== "fingerprint" ||
          /^[A-Za-z0-9._~-]{1,255}$/.test(target)) &&
        values.channel === values.channel.trim().normalize("NFC") &&
        [...values.channel].length <= 255,
      "Use the app's canonical channel and version or fingerprint as the catalog target.",
    );
    const channelKey = Buffer.from(values.channel).toString("base64url");
    const scopeKey = `v1:${strategy}:${values.platform}:${channelKey}${
      strategy === "fingerprint" ? `:${target}` : ""
    }`;
    const routeUrl = (route: string) => {
      const url = new URL(baseUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${route}`;
      return url;
    };
    const catalogUrl = routeUrl(
      `release-catalogs/${strategy}/${values.platform}/${channelKey}/${encodeURIComponent(target)}`,
    );

    check = "version";
    const version = await request(routeUrl("version"));
    requireCheck(version.response.status === 200, "The version probe failed.");
    const versionBody = parseJson(version.body);
    requireCheck(
      isObject(versionBody) &&
        versionBody["version"] === options.serverVersion &&
        versionBody["infrastructureGeneration"] ===
          options.infrastructureGeneration,
      "Server version or infrastructure generation does not match the scaffold.",
    );

    check = "anonymous-catalog";
    const anonymous = await request(catalogUrl);
    requireCheck(
      anonymous.response.status === 401,
      "The catalog must reject a request without the client key with HTTP 401.",
    );

    check = "authenticated-catalog";
    const authenticated = await request(catalogUrl, apiKey);
    const catalog = parseJson(authenticated.body);
    const contentType =
      authenticated.response.headers.get("content-type") ?? "";
    const empty = authenticated.response.status === 404;
    if (empty) {
      const cacheControl = authenticated.response.headers
        .get("cache-control")
        ?.toLowerCase()
        .split(",")
        .map((directive) => directive.trim());
      requireCheck(
        /^application\/json(?:;|$)/i.test(contentType) &&
          isObject(catalog) &&
          Object.keys(catalog).length === 1 &&
          catalog["error"] === "Not found" &&
          cacheControl?.includes("private") &&
          cacheControl.includes("no-store"),
        "HTTP 404 must be the private, non-cacheable empty-catalog response.",
      );
    } else {
      requireCheck(
        authenticated.response.status === 200 &&
          /^application\/vnd\.hot-updater\.release-catalog\+json;\s*version=1(?:;|$)/i.test(
            contentType,
          ) &&
          isObject(catalog) &&
          catalog["schemaVersion"] === 1 &&
          isText(catalog["catalogId"]) &&
          typeof catalog["catalogHash"] === "string" &&
          /^sha256:[0-9a-f]{64}$/.test(catalog["catalogHash"]) &&
          catalog["scopeKey"] === scopeKey &&
          Number.isSafeInteger(catalog["generation"]) &&
          typeof catalog["generation"] === "number" &&
          catalog["generation"] >= 1 &&
          catalog["fallbackPolicy"] === "BUILTIN_IF_ACTIVE_INELIGIBLE" &&
          Array.isArray(catalog["releases"]) &&
          catalog["releases"].every(isDescriptor) &&
          (catalog["rollbackReleases"] === undefined ||
            (Array.isArray(catalog["rollbackReleases"]) &&
              catalog["rollbackReleases"].every(isDescriptor))) &&
          new Set(
            [
              ...catalog["releases"],
              ...(catalog["rollbackReleases"] ?? []),
            ].flatMap((release) =>
              isObject(release) && Array.isArray(release["targetCohorts"])
                ? release["targetCohorts"]
                : [],
            ),
          ).size <= 512,
        "The authenticated request must return a valid release catalog for the requested scope.",
      );
    }
    return {
      status: "verified",
      checks: {
        version: "matches-manifest",
        anonymousCatalog: 401,
        authenticatedCatalog: authenticated.response.status,
        catalog: empty ? "empty" : "available",
      },
    };
  } catch (error) {
    return {
      status: "failed",
      check,
      error:
        error instanceof VerificationError
          ? error.message
          : "Verification failed. Check local configuration, server access and response time.",
    };
  }
}

import {
  defineFirstPartyFeatureManifest,
  type HotUpdaterAuthenticationInput,
  type HotUpdaterAuthenticationProvider,
  type NoFeatureApiKind,
} from "@hot-updater/server/internal/first-party-plugin";

import packageJson from "../package.json" with { type: "json" };
import { decodeBase64Url32 } from "./base64url";

const DEFAULT_HEADER_NAME = "x-api-key";
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAXIMUM_HEADER_NAME_LENGTH = 128;
const API_KEY_LENGTH = 43;

export type ApiKeyPluginOptions = {
  readonly headerName?: string;
  readonly sha256: string;
};

const readHeaderName = (value: string | undefined): string => {
  const headerName = value ?? DEFAULT_HEADER_NAME;
  if (
    headerName.length === 0 ||
    headerName.length > MAXIMUM_HEADER_NAME_LENGTH ||
    !HEADER_NAME_PATTERN.test(headerName)
  ) {
    throw new TypeError("apiKey headerName must be a valid HTTP field name.");
  }
  return headerName.toLowerCase();
};

const readDigest = (value: string): Uint8Array => {
  const digest = decodeBase64Url32(value);
  if (digest === undefined) {
    throw new TypeError(
      "apiKey sha256 must be a canonical base64url SHA-256 digest.",
    );
  }
  return digest;
};

const isApiKey = (value: string | null): value is string =>
  value !== null &&
  value.length === API_KEY_LENGTH &&
  decodeBase64Url32(value) !== undefined;

const matchesDigest = (actual: Uint8Array, expected: Uint8Array): boolean => {
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
};

const createAuthenticationProvider = (
  headerName: string,
  expectedDigest: Uint8Array,
): HotUpdaterAuthenticationProvider =>
  Object.freeze({
    id: "hot-updater-api-key",
    async authenticate(input: HotUpdaterAuthenticationInput) {
      const candidate = input.headers.get(headerName);
      if (!isApiKey(candidate)) {
        return Object.freeze({ kind: "anonymous" });
      }

      const actualDigest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(candidate),
        ),
      );
      if (!matchesDigest(actualDigest, expectedDigest)) {
        return Object.freeze({ kind: "anonymous" });
      }

      return Object.freeze({
        kind: "authenticated",
        principal: Object.freeze({
          issuer: "hot-updater-api-key",
          subject: "managed",
        }),
      });
    },
  });

export const apiKey = (options: ApiKeyPluginOptions) => {
  const authentication = createAuthenticationProvider(
    readHeaderName(options.headerName),
    readDigest(options.sha256),
  );

  return defineFirstPartyFeatureManifest<
    "api-key",
    NoFeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "api-key",
    namespace: "api-key",
    setup: () => ({
      authentication,
      routePolicy: { kind: "protect-all" },
    }),
    version: packageJson.version,
  });
};

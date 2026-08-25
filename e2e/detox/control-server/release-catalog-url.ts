import { encodeChannelKey } from "../../../packages/core/src/releaseCatalogScope.ts";
import { canonicalizeAppVersion } from "../../../plugins/plugin-core/src/releaseCatalogCompiler.ts";

type ReleaseCatalogUrlBaseInput = {
  readonly baseUrl: string;
  readonly channel: string;
  readonly platform: "android" | "ios";
};

export type ReleaseCatalogUrlInput = ReleaseCatalogUrlBaseInput &
  (
    | {
        readonly appVersion: string;
        readonly fingerprintHash?: never;
        readonly strategy: "appVersion";
      }
    | {
        readonly appVersion?: never;
        readonly fingerprintHash: string;
        readonly strategy: "fingerprint";
      }
  );

export function buildReleaseCatalogUrl(input: ReleaseCatalogUrlInput): string {
  let strategyValue: string;
  if (input.strategy === "fingerprint") {
    strategyValue = input.fingerprintHash;
    if (strategyValue.length === 0) {
      throw new Error("Invalid Release catalog fingerprint hash");
    }
  } else {
    const appVersion = canonicalizeAppVersion(input.appVersion);
    if (appVersion === null) {
      throw new Error(
        `Invalid Release catalog app version: ${input.appVersion}`,
      );
    }
    strategyValue = appVersion;
  }

  return [
    input.baseUrl.replace(/\/+$/, ""),
    `release-catalogs/${
      input.strategy === "fingerprint" ? "fingerprint" : "app-version"
    }`,
    input.platform,
    encodeChannelKey(input.channel),
    encodeURIComponent(strategyValue),
  ].join("/");
}

export function assertCatalogUrlHasNoDeviceState(
  url: string,
  forbiddenValues: readonly string[],
): void {
  const decodedUrl = decodeURIComponent(url);
  for (const value of forbiddenValues) {
    if (value.length > 0 && decodedUrl.includes(value)) {
      throw new Error(`Release catalog URL exposes device state: ${value}`);
    }
  }
}

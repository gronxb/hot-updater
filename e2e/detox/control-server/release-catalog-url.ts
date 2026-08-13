import { encodeChannelKey } from "../../../packages/core/src/releaseCatalogScope.ts";
import { canonicalizeAppVersion } from "../../../plugins/plugin-core/src/releaseCatalogCompiler.ts";

export type ReleaseCatalogUrlInput = {
  readonly appVersion: string;
  readonly authorityId: string;
  readonly baseUrl: string;
  readonly channel: string;
  readonly platform: "android" | "ios";
};

export function buildReleaseCatalogUrl(input: ReleaseCatalogUrlInput): string {
  const appVersion = canonicalizeAppVersion(input.appVersion);
  if (appVersion === null) {
    throw new Error(`Invalid Release catalog app version: ${input.appVersion}`);
  }

  return [
    input.baseUrl.replace(/\/+$/, ""),
    "v2/release-catalogs/app-version",
    encodeURIComponent(input.authorityId),
    input.platform,
    encodeChannelKey(input.channel),
    encodeURIComponent(appVersion),
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

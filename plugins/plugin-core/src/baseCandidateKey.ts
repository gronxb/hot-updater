import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  parseReleaseCatalogScopeKey,
} from "@hot-updater/protocol";
import { normalizeRange } from "verkit";

/** A new bundle's auto-patch target: where it is released, and to whom. */
export interface BaseCandidateTarget {
  readonly channel: string;
  readonly platform: "ios" | "android";
  readonly fingerprintHash: string | null;
  readonly appVersion: string | null;
}

/** What a base-candidate key names: a catalog scope, and an app-version scope's target range. */
export interface BaseCandidateQuery {
  readonly scopeKey: string;
  readonly range: string | null;
}

/**
 * A new bundle's base-candidate key, which `findBaseBundleIds` on core's API
 * and on a plugin's `ctx.core` takes: the Release Catalog scope its devices
 * update from, and for an app version its normalized range; null for a
 * target without a valid range. The CLI's deploy produces it this way.
 */
export const targetBaseCandidateKey = (
  target: BaseCandidateTarget,
): string | null => {
  const channelKey = encodeChannelKey(target.channel);
  if (target.fingerprintHash) {
    return JSON.stringify([
      createReleaseCatalogScopeKey({
        channelKey,
        fingerprintHash: target.fingerprintHash,
        platform: target.platform,
        strategy: "FINGERPRINT",
      }),
    ]);
  }
  const range =
    target.appVersion === null ? null : normalizeRange(target.appVersion);
  return range === null
    ? null
    : JSON.stringify([
        createReleaseCatalogScopeKey({
          channelKey,
          platform: target.platform,
          strategy: "APP_VERSION",
        }),
        range,
      ]);
};

/**
 * The scope and range a base-candidate key names, null for any other
 * string: what an implementation of `findBaseBundleIds` reads the key with.
 */
export const parseBaseCandidateKey = (
  key: string,
): BaseCandidateQuery | null => {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
    const [scopeKey, text] = parsed as [string, unknown];
    const { strategy } = parseReleaseCatalogScopeKey(scopeKey);
    if (strategy === "FINGERPRINT") {
      return parsed.length === 1 ? { scopeKey, range: null } : null;
    }
    const range =
      parsed.length === 2 && typeof text === "string"
        ? normalizeRange(text)
        : null;
    return range === null ? null : { scopeKey, range };
  } catch {
    return null;
  }
};

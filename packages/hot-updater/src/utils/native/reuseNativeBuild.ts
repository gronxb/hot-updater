import path from "node:path";

import type { EnrichedNativeBuildAndroidScheme } from "@hot-updater/android-helper";
import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import {
  type CredentialResolver,
  getCwd,
  p,
  parseSecretReference,
  startStep,
} from "@hot-updater/cli-tools";
import type { NativeBuildScope, Platform } from "@hot-updater/plugin-core";

import { version } from "../../packageJson";
import { ui } from "../cli-ui";
import { getChannel } from "../setChannel";
import {
  computeNativeBuildKey,
  diffNativeBuildKeyComponents,
  type NativeBuildKey,
  type NativeBuildKeySigning,
} from "./buildKey";
import type {
  NativeBuildArtifactKind,
  NativeBuildResult,
  NativeBuildTarget,
} from "./createNativeBuild";
import {
  findCachedNativeBuild,
  markCachedNativeBuildTracked,
  type NativeBuildCacheHit,
  nativeBuildCacheSlot,
  saveCachedNativeBuild,
} from "./nativeBuildCache";

/**
 * What `--json` prints of the cache: where the build came from (`hit`), its
 * key, why no build could be reused (`uncacheable`), and what changed since
 * this machine's cached build of the scheme (`changed`).
 */
export interface NativeBuildCacheReport {
  readonly hit: NativeBuildCacheHit["source"] | null;
  readonly key: string | null;
  readonly uncacheable: string | null;
  readonly changed: readonly string[];
}

/** A changed component as a log line names it, such as `src/App.tsx`. */
const describeChange = (change: string) => {
  const [component, ...rest] = change.split(":");
  const name = rest.join(":");
  switch (component) {
    case "file":
      return name;
    case "input":
      return name.replace(/^file:/, "").replace(/^([\w-]+):/, "$1 ");
    case "env":
      return `$${name}`;
    case "engine":
      return "engine";
    default:
      return `${component} ${name}`;
  }
};

/** The longest reason a build is uncacheable that its line holds. */
const SHORT_REASON_WIDTH = 48;

/** The widest a changed component's name is on the cache's line. */
const CHANGE_WIDTH = 32;

/** The changes in a few words: `engine changed`, `App.tsx +2 changed`. */
const summarizeChanges = (changed: readonly string[]) => {
  const first = describeChange(changed[0]!);
  const name =
    first.length > CHANGE_WIDTH
      ? `…${first.slice(-(CHANGE_WIDTH - 1))}`
      : first;
  return changed.length > 1
    ? `${name} +${changed.length - 1} changed`
    : `${name} changed`;
};

/** What the build log says of the cache, which the terminal shortens. */
const cacheLogLines = (
  key: string | null,
  changed: readonly string[] = [],
): string[] => [
  `Native build key  ${key ?? "none"}`,
  ...changed.map((change) => `Changed           ${describeChange(change)}`),
];

/** The artifact a scheme builds. */
const artifactKindOf = (
  platform: Platform,
  iosScheme?: EnrichedNativeBuildIosScheme,
  androidScheme?: EnrichedNativeBuildAndroidScheme,
): NativeBuildArtifactKind =>
  platform === "ios"
    ? iosScheme!.simulator
      ? "app"
      : "ipa"
    : androidScheme!.aab
      ? "aab"
      : "apk";

/**
 * The signing identity the build signs with: the release keystore's
 * certificate, or the App Store Connect API key's IDs, resolved as the
 * build resolves them.
 */
const resolveSigningIdentity = async (
  credentials: Pick<CredentialResolver, "resolve">,
  iosScheme?: EnrichedNativeBuildIosScheme,
  androidScheme?: EnrichedNativeBuildAndroidScheme,
): Promise<NativeBuildKeySigning> => {
  const keystore = androidScheme?.signing?.keystore;
  if (keystore && !/debug$/i.test(androidScheme.variant)) {
    const { storeFile, storePassword, keyAlias } = await credentials.resolve({
      kind: "android-keystore",
      name: parseSecretReference(keystore, "signing.keystore"),
    });
    return { androidKeystore: { storeFile, storePassword, keyAlias } };
  }
  const ascApiKey = iosScheme?.simulator
    ? undefined
    : iosScheme?.signing?.ascApiKey;
  if (ascApiKey) {
    const { keyId, issuerId } = await credentials.resolve({
      kind: "asc-api-key",
      name: parseSecretReference(ascApiKey, "signing.ascApiKey"),
    });
    return { ascApiKey: { keyId, issuerId } };
  }
  return {};
};

/** A build's cache: its key, its slot, and the build it reuses. */
export interface NativeBuildCache {
  readonly key: NativeBuildKey;
  /** This machine's slot for the scheme, or null with `cacheDir: null`. */
  readonly slot: string | null;
  readonly hit: NativeBuildCacheHit | null;
  readonly report: NativeBuildCacheReport;
  /** The build log's lines of the cache: the whole key and what changed. */
  readonly logHeader: readonly string[];
  /**
   * Keeps a new build in the slot, and the registry's ID once it is
   * tracked, for the next run on this machine.
   */
  readonly remember: (
    result: NativeBuildResult,
    nativeBuildId: string | null,
  ) => Promise<void>;
}

/**
 * Computes the build's native build key, and finds a build with the same
 * key to reuse: one the registry tracks, else this machine's cached build
 * of the scheme. A line says which one it reuses, or why it builds: no
 * build with the key, with what changed since the cached one, an input no
 * key covers, or `--no-cache`, which still records the key.
 */
export const reuseNativeBuild = async ({
  platform,
  scheme,
  cacheDir,
  outputPath,
  target,
  iosScheme,
  androidScheme,
  credentials,
  noCache,
  buildAdapter,
}: {
  platform: Platform;
  scheme: string;
  /** The config's `cacheDir`, as it sets it. */
  cacheDir: string | null;
  outputPath: string;
  target: NativeBuildTarget;
  iosScheme?: EnrichedNativeBuildIosScheme;
  androidScheme?: EnrichedNativeBuildAndroidScheme;
  credentials: Pick<CredentialResolver, "resolve">;
  noCache: boolean;
  /** The config's build adapter's name, whose autolinking the key reads. */
  buildAdapter?: string;
}): Promise<NativeBuildCache> => {
  const cwd = getCwd();
  const resolvedCacheDir =
    cacheDir === null ? null : path.resolve(cwd, cacheDir);
  // The channel the build falls back to, as createNativeBuild reads it.
  const channel = (await getChannel(platform)).value;
  const step = startStep("Checking the build cache");
  // A key that can't be computed only costs the reuse: the command builds.
  const key: NativeBuildKey = await computeNativeBuildKey({
    cwd,
    platform,
    scheme,
    schemeConfig: (platform === "ios" ? iosScheme : androidScheme) as Record<
      string,
      unknown
    >,
    artifactKind: artifactKindOf(platform, iosScheme, androidScheme),
    channel,
    ...target,
    outputPath,
    cacheDir: resolvedCacheDir,
    signing: await resolveSigningIdentity(
      credentials,
      iosScheme,
      androidScheme,
    ),
    hotUpdaterVersion: version ?? "unknown",
    buildAdapter,
  }).catch((error: unknown) => ({
    key: null,
    components: null,
    uncacheable: `the native build key could not be computed (${error instanceof Error ? error.message : String(error)})`,
  }));
  const slot =
    resolvedCacheDir === null || key.key === null
      ? null
      : nativeBuildCacheSlot(resolvedCacheDir, platform, scheme);
  const remember = async (
    result: NativeBuildResult,
    nativeBuildId: string | null,
  ) => {
    if (slot === null || key.key === null) return;
    try {
      await saveCachedNativeBuild({
        slot,
        key: key.key,
        components: key.components,
        build: result,
        outputPath,
        nativeBuildId,
      });
    } catch (error) {
      p.log.warn(
        `Couldn't cache the build on this machine.\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const report = (
    hit: NativeBuildCacheHit | null,
    changed: readonly string[] = [],
  ): NativeBuildCacheReport => ({
    hit: hit?.source ?? null,
    key: key.key,
    uncacheable: key.uncacheable ?? (noCache ? "--no-cache" : null),
    changed,
  });

  const logHeader = cacheLogLines(key.key);
  if (key.key === null) {
    const reason = key.uncacheable ?? "";
    // A short reason fits the line; a long one, such as an error, follows.
    if (reason.length <= SHORT_REASON_WIDTH) {
      step.succeed(`Cache skipped · ${reason}`, { level: "info" });
    } else {
      step.succeed("Cache skipped", { level: "info" });
      p.log.message(ui.prose(reason));
    }
    return { key, slot, hit: null, report: report(null), logHeader, remember };
  }
  if (noCache) {
    step.succeed("Cache skipped · --no-cache", { level: "info" });
    return { key, slot, hit: null, report: report(null), logHeader, remember };
  }

  const predictedScope: NativeBuildScope =
    target.fingerprintHash === null
      ? {
          platform,
          channel,
          fingerprintHash: null,
          appVersion: target.appVersion,
        }
      : {
          platform,
          channel,
          fingerprintHash: target.fingerprintHash,
          appVersion: null,
        };
  let lookup: Awaited<ReturnType<typeof findCachedNativeBuild>>;
  try {
    lookup = await findCachedNativeBuild({
      key: key.key,
      scheme,
      slot,
      predictedScope,
      outputPath,
    });
  } catch (error) {
    step.succeed("Cache unavailable · building", { level: "warn" });
    p.log.warn(error instanceof Error ? error.message : String(error));
    return { key, slot, hit: null, report: report(null), logHeader, remember };
  }
  const { hit, cached, missingArtifact, takenMinBundleId } = lookup;
  if (hit !== null) {
    const id =
      hit.source === "storage"
        ? hit.nativeBuild.id
        : (hit.nativeBuildId ?? hit.result.minBundleId);
    step.succeed(
      `Cache hit · ${hit.source === "storage" ? "storage" : "this machine"} · ${ui.id(id)}`,
    );
    // A build downloaded from storage is kept here for the next run, and
    // one copied from here is marked tracked.
    if (hit.source === "storage") {
      if (
        cached?.key === key.key &&
        cached.build.minBundleId === hit.nativeBuild.min_bundle_id
      ) {
        await rememberTrackedBuild(
          { key, slot, hit, report: report(hit), logHeader, remember },
          hit.nativeBuild.id,
        );
      } else {
        await remember(hit.result, hit.nativeBuild.id);
      }
    }
    return { key, slot, hit, report: report(hit), logHeader, remember };
  }

  const changed =
    cached === null
      ? []
      : diffNativeBuildKeyComponents(cached.components, key.components);
  step.succeed(
    missingArtifact
      ? "Cache miss · the tracked build has no artifact"
      : takenMinBundleId
        ? "Cache miss · its MIN_BUNDLE_ID is taken"
        : changed.length > 0
          ? `Cache miss · ${summarizeChanges(changed)}`
          : "Cache miss · no build has this key",
    { level: "info" },
  );
  return {
    key,
    // The slot's build is the tracked one that lost its artifact, or one
    // whose MIN_BUNDLE_ID another build registered: either way its built-in
    // bundle is registered, so it is replaced, never reused.
    slot,
    hit: null,
    report: report(null, changed),
    logHeader: [
      ...cacheLogLines(key.key, changed),
      ...(missingArtifact ? [`Tracked build     ${missingArtifact.id}`] : []),
      ...(takenMinBundleId
        ? [`MIN_BUNDLE_ID     ${cached!.build.minBundleId} (taken)`]
        : []),
    ],
    remember,
  };
};

/** Records the registry's ID of the slot's build once it is tracked. */
export const rememberTrackedBuild = async (
  cache: NativeBuildCache,
  nativeBuildId: string,
) => {
  if (cache.slot === null || cache.key.key === null) return;
  await markCachedNativeBuildTracked(
    cache.slot,
    cache.key.key,
    nativeBuildId,
  ).catch(() => undefined);
};

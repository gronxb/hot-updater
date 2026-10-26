import path from "node:path";

import type { EnrichedNativeBuildAndroidScheme } from "@hot-updater/android-helper";
import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import {
  type CredentialResolver,
  getCwd,
  p,
  parseSecretReference,
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

/** The key's start, enough to tell two keys apart in a log line. */
const shortKey = (key: string) => `${key.slice(0, 17)}…`;

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
      return "the key's engine";
    default:
      return `${component} ${name}`;
  }
};

const describeChanges = (changed: readonly string[]) => {
  const shown = changed.slice(0, 5).map(describeChange).join(", ");
  return changed.length > 5 ? `${shown} (+${changed.length - 5} more)` : shown;
};

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
}): Promise<NativeBuildCache> => {
  const cwd = getCwd();
  const resolvedCacheDir =
    cacheDir === null ? null : path.resolve(cwd, cacheDir);
  // The channel the build falls back to, as createNativeBuild reads it.
  const channel = (await getChannel(platform)).value;
  const startedAt = performance.now();
  const key = await computeNativeBuildKey({
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
  });
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
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
        `The build was not cached on this machine: ${error instanceof Error ? error.message : String(error)}`,
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

  if (key.key === null) {
    p.log.info(`Building: no build can be reused, as ${key.uncacheable}.`);
    return { key, slot, hit: null, report: report(null), remember };
  }
  if (noCache) {
    p.log.info(
      ui.line([
        "Building: --no-cache reuses no build",
        ui.muted(`(key ${shortKey(key.key)}, computed in ${seconds} s)`),
      ]),
    );
    return { key, slot, hit: null, report: report(null), remember };
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
    p.log.warn(
      `Building: the build with key ${shortKey(key.key)} could not be reused: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { key, slot, hit: null, report: report(null), remember };
  }
  const { hit, cached, missingArtifact } = lookup;
  if (hit !== null) {
    const id =
      hit.source === "storage"
        ? hit.nativeBuild.id
        : (hit.nativeBuildId ?? hit.result.minBundleId);
    p.log.success(
      [
        ui.line([
          "Reusing native build",
          ui.id(id),
          ui.muted(`(key ${shortKey(key.key)}; ${hit.source})`),
        ]),
        `    ${ui.muted("Artifact:")} ${ui.path(path.relative(cwd, hit.result.artifactPath))}`,
      ].join("\n"),
    );
    // A build downloaded from storage is kept here for the next run.
    if (hit.source === "storage" && cached?.key !== key.key) {
      await remember(hit.result, hit.nativeBuild.id);
    }
    return { key, slot, hit, report: report(hit), remember };
  }

  const changed =
    cached === null
      ? []
      : diffNativeBuildKeyComponents(cached.components, key.components);
  const why = missingArtifact
    ? `the tracked build ${missingArtifact.id} with this key has no artifact in storage`
    : cached === null
      ? "no tracked build has this key, and none is cached on this machine"
      : `no tracked build has this key; changed since this machine's cached build: ${describeChanges(changed)}`;
  p.log.info(
    ui.line([`Building: ${why}`, ui.muted(`(key ${shortKey(key.key)})`)]),
  );
  return {
    key,
    // The slot's build is the tracked one that lost its artifact: its
    // built-in bundle is registered, so it is replaced, never reused.
    slot,
    hit: null,
    report: report(null, changed),
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

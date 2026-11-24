import {
  type CompiledReleaseCatalog,
  type HotUpdaterCoreApi,
  type NativeBuildRow,
  projectCompiledCatalog,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
} from "@hot-updater/protocol";

const CHANNEL_ID_PREFIX = "channel:";

/** `value` as one POSIX shell word, so a pasted command runs nothing else. */
const shellWord = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The command that adds a patch from a build's built-in bundle to an OTA's
 * artifact: `-b` is `--artifact-id`.
 */
export const storeBuildPatchCommand = (
  build: Pick<NativeBuildRow, "platform" | "min_bundle_id">,
  channel: string,
  artifactId: string,
): string =>
  [
    "npx hot-updater patch",
    `-p ${build.platform}`,
    `-c ${shellWord(channel)}`,
    `-b ${shellWord(artifactId)}`,
    `--base-artifact-id ${shellWord(build.min_bundle_id)}`,
  ].join(" ");

/** The OTA a fresh install gets first, which has no patch from the build. */
export interface MissingStorePatch {
  /** The OTA's bundle ID, as users know it: its release's ID. */
  readonly releaseId: string;
  /** The release's label, or null for one without. */
  readonly label: number | null;
  /** The artifact the release serves, which the patch updates to. */
  readonly artifactId: string;
  readonly command: string;
}

/**
 * The OTA a fresh install of a marked build gets first, when it has no patch
 * from the build, and the command that adds one: the newest release of the
 * build's scope that serves anyone, in its catalog at the build's app
 * version. A release at 0% with no cohort serves no install, so the one
 * before it is the OTA. Two reads: the scope's catalog and that OTA's
 * artifact. Null when the scope serves the build no OTA, or the OTA has the
 * patch.
 */
export const findMissingStorePatch = async (
  core: Pick<HotUpdaterCoreApi, "getReleaseCatalogRow" | "getBundle">,
  build: NativeBuildRow,
): Promise<MissingStorePatch | null> => {
  const channelKey = build.channel_id.slice(CHANNEL_ID_PREFIX.length);
  const scopeKey =
    build.fingerprint_hash === null
      ? createReleaseCatalogScopeKey({
          channelKey,
          platform: build.platform,
          strategy: "APP_VERSION",
        })
      : createReleaseCatalogScopeKey({
          channelKey,
          fingerprintHash: build.fingerprint_hash,
          platform: build.platform,
          strategy: "FINGERPRINT",
        });
  const catalog = await core.getReleaseCatalogRow(scopeKey);
  if (catalog === null || catalog.is_tombstone) return null;
  const served = projectCompiledCatalog(
    JSON.parse(catalog.payload) as CompiledReleaseCatalog,
    build.app_version ?? undefined,
  ).find(
    ({ rolloutCohortCount, targetCohorts }) =>
      rolloutCohortCount > 0 || targetCohorts.length > 0,
  );
  const artifactId = served?.bundleId ?? null;
  // A rollback, or a release older than the build, gives a fresh install no OTA.
  if (
    served === undefined ||
    artifactId === null ||
    artifactId <= build.min_bundle_id
  ) {
    return null;
  }
  const ota = await core.getBundle(artifactId);
  if (
    ota === null ||
    ota.patches.some(
      ({ base_bundle_id }) => base_bundle_id === build.min_bundle_id,
    )
  ) {
    return null;
  }
  return {
    releaseId: served.releaseId,
    label: served.label ?? null,
    artifactId,
    command: storeBuildPatchCommand(
      build,
      decodeChannelKey(channelKey),
      artifactId,
    ),
  };
};

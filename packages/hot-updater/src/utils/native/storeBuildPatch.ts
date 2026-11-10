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

/** The command that adds a patch from a build's built-in bundle to an OTA. */
export const storeBuildPatchCommand = (
  build: Pick<NativeBuildRow, "platform" | "min_bundle_id">,
  channel: string,
  bundleId: string,
): string =>
  [
    "npx hot-updater patch",
    `-p ${build.platform}`,
    `-c ${shellWord(channel)}`,
    `-b ${shellWord(bundleId)}`,
    `--base-artifact-id ${shellWord(build.min_bundle_id)}`,
  ].join(" ");

/**
 * The OTA a fresh install of a marked build gets first, when it has no patch
 * from the build, and the command that adds one: the newest release of the
 * build's scope that serves anyone, in its catalog at the build's app
 * version. A release at 0% with no cohort serves no install, so the one
 * before it is the OTA. Two reads: the scope's catalog and that OTA. Null
 * when the scope serves the build no OTA, or the OTA has the patch.
 */
export const findMissingStorePatch = async (
  core: Pick<HotUpdaterCoreApi, "getReleaseCatalogRow" | "getBundle">,
  build: NativeBuildRow,
): Promise<{ readonly bundleId: string; readonly command: string } | null> => {
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
  const bundleId = served?.bundleId ?? null;
  // A rollback, or a release older than the build, gives a fresh install no OTA.
  if (bundleId === null || bundleId <= build.min_bundle_id) return null;
  const ota = await core.getBundle(bundleId);
  if (
    ota === null ||
    ota.patches.some(
      ({ base_bundle_id }) => base_bundle_id === build.min_bundle_id,
    )
  ) {
    return null;
  }
  return {
    bundleId,
    command: storeBuildPatchCommand(
      build,
      decodeChannelKey(channelKey),
      bundleId,
    ),
  };
};

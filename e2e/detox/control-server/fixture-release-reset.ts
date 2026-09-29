import type { HotUpdaterCoreApi } from "../../../plugins/plugin-core/dist/index.mjs";

const PAGE = 500;

export function getFixtureResetChannels(namespace: string | null) {
  if (!namespace?.trim()) {
    throw new Error(
      "Set HOT_UPDATER_E2E_CHANNEL_NAMESPACE to a unique E2E job namespace before resetting provider state.",
    );
  }
  return ["production", "beta"].map(
    (channel) => `${namespace.trim()}-${channel}`,
  );
}

/**
 * Disables and deletes this job's releases on one platform, through core.
 * Each channel's releases are read by the channel and platform index; the
 * read starts over after each page, since the page's releases are gone.
 */
export async function resetFixtureReleases({
  core,
  namespace,
  platform,
}: {
  core: Pick<
    HotUpdaterCoreApi,
    "deleteRelease" | "listChannels" | "listReleases" | "updateReleasePolicy"
  >;
  namespace: string | null;
  platform: "ios" | "android";
}) {
  const channels = getFixtureResetChannels(namespace);
  const channelIds = (await core.listChannels())
    .filter((channel) => channels.includes(channel.name))
    .map((channel) => channel.id);
  const clearedReleaseIds: string[] = [];
  for (const channelId of channelIds) {
    for (;;) {
      const releases = await core.listReleases({
        filter: { kind: "channelPlatform", channelId, platform },
        order: "asc",
        limit: PAGE,
      });
      for (const release of releases) {
        if (release.enabled) {
          await core.updateReleasePolicy({
            patch: { enabled: false },
            releaseId: release.id,
          });
        }
        await core.deleteRelease({ releaseId: release.id });
        clearedReleaseIds.push(release.id);
      }
      if (releases.length < PAGE) break;
    }
  }
  // Artifacts can be shared by Releases and patch bases outside this fixture.
  return { channels, clearedReleaseIds };
}

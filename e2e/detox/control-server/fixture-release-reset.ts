import {
  type BundleRepository,
  deleteRelease,
  updateReleasePolicy,
} from "../../../plugins/plugin-core/dist/index.mjs";

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

export async function resetFixtureReleases({
  database,
  namespace,
  platform,
}: {
  database: BundleRepository;
  namespace: string | null;
  platform: "ios" | "android";
}) {
  const channels = getFixtureResetChannels(namespace);
  const channelIds = (await database.models.channels.list({})).channels
    .filter((channel) => channels.includes(channel.name))
    .map((channel) => channel.id);
  const clearedReleaseIds: string[] = [];
  for (const channelId of channelIds) {
    for (;;) {
      const releases = await database.models.releases.findMany({
        channelId,
        limit: 1_000,
        platform,
      });
      for (const release of releases) {
        if (release.enabled) {
          await updateReleasePolicy({
            database,
            patch: { enabled: false },
            releaseId: release.id,
          });
        }
        await deleteRelease({ database, releaseId: release.id });
        clearedReleaseIds.push(release.id);
      }
      if (releases.length < 1_000) break;
    }
  }
  // Artifacts can be shared by Releases and patch bases outside this fixture.
  return { channels, clearedReleaseIds };
}

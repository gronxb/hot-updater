import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  type NativeBuildRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";

import { expoConfigFile } from "@/utils/expoDetection";
import { loadServer } from "@/utils/loadServer";
import { setChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";
import { printBanner } from "../utils/printBanner";
import { withPublicBundleErrors } from "../utils/publicBundleError";
import { confirmMutation, safeDispose } from "./release";

const NATIVE_CHANNEL_FILES = [
  { platform: "android", name: "Android", file: "AndroidManifest.xml" },
  { platform: "ios", name: "iOS", file: "Info.plist" },
] as const;

/**
 * Writes the default channel into the native files, and says per platform
 * whether it wrote any. In an Expo CNG project the build takes the channel
 * from the `@hot-updater/expo` plugin's `channel` option, which
 * `expo prebuild` writes into the native files, so it points there: in
 * `app.json`, the option set to this channel; in a dynamic `app.config.*`,
 * the option read from the user's own environment variable, as the pull
 * request preview guide does, with the variable to build with.
 */
export const handleSetChannel = async (channel: string) => {
  const expoConfig = expoConfigFile();
  let written = false;
  for (const { platform, name, file } of NATIVE_CHANNEL_FILES) {
    const { paths } = await setChannel(platform, channel);
    if (paths.length === 0) {
      p.log.info(
        ui.line([
          "No",
          file,
          "found:",
          "nothing was written for",
          `${ui.platform(name)}.`,
        ]),
      );
      continue;
    }
    written = true;
    p.log.success(ui.line(["Set", ui.platform(name), ui.channel(channel)]));
    p.log.message(
      ui.block(
        `${name} paths`,
        paths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
      ),
    );
  }

  if (expoConfig !== null) {
    const source = `This Expo project's builds take the channel from the @hot-updater/expo plugin's \`channel\` option in ${expoConfig}, which \`expo prebuild\` writes into the native files${written ? ", replacing what was written here" : ""}.`;
    p.log.info(
      (expoConfig === "app.json"
        ? [
            `${source} Set it there:`,
            `  "plugins": [["@hot-updater/expo", { "channel": ${JSON.stringify(channel)} }]]`,
          ]
        : [
            `${source} To build ${channel} without editing it, read the channel from an environment variable there, as the pull request preview guide does:`,
            '  plugins: [["@hot-updater/expo", { channel: process.env.PREVIEW_CHANNEL ?? "production" }]]',
            `Then build with PREVIEW_CHANNEL=${channel}.`,
          ]
      ).join("\n"),
    );
  }

  if (written) {
    p.log.warn("Rebuild native app after changing channel.");
  }
};

const PAGE = 100;

/**
 * Deletes a channel with its bundles, as when a pull request's channel
 * closes: each bundle is disabled and deleted, then the channel. With
 * `nativeBuilds`, the native builds that embed the channel go too, each
 * with its built-in bundle and its artifact, as `native-build delete`
 * deletes one. A missing channel deletes nothing and succeeds, so the
 * cleanup can run again. Without `nativeBuilds`, a native build that embeds
 * the channel keeps it: its bundles are deleted, the channel is not, and
 * the command fails.
 */
export const handleChannelDelete = (
  channel: string,
  options: {
    readonly json?: boolean;
    readonly yes?: boolean;
    readonly nativeBuilds?: boolean;
  },
) =>
  withPublicBundleErrors(async () => {
    if (!options.json) printBanner();
    const server = await loadServer(await loadConfig(null));
    try {
      const core = server.core;
      const row = await core.findChannelByName(channel);
      if (row === null) {
        if (options.json) {
          console.log(
            JSON.stringify({ channel, deleted: false, reason: "not_found" }),
          );
        } else {
          p.log.info(
            ui.line(["No channel named", ui.channel(channel), "to delete."]),
          );
        }
        return;
      }

      const releases: ReleaseRow[] = [];
      for (const platform of ["ios", "android"] as const) {
        for (let after: string | undefined; ; ) {
          const page = await core.listReleases({
            filter: { kind: "channelPlatform", channelId: row.id, platform },
            limit: PAGE,
            ...(after === undefined ? {} : { after }),
          });
          releases.push(...page);
          if (page.length < PAGE) break;
          after = page.at(-1)!.id;
        }
      }

      const builds: NativeBuildRow[] = [];
      let deleteArtifact: ((storageUri: string) => Promise<unknown>) | null =
        null;
      if (options.nativeBuilds) {
        // Checked before anything is deleted, so no artifact is left behind.
        const storage = server.storage;
        assertStorageOperations(storage, ["delete"]);
        deleteArtifact = (storageUri) => storage.delete({ storageUri });
        for (let after: string | undefined; ; ) {
          const page = await core.listNativeBuilds({
            channelId: row.id,
            limit: PAGE,
            ...(after === undefined ? {} : { after }),
          });
          builds.push(...page);
          if (page.length < PAGE) break;
          after = page.at(-1)!.id;
        }
      }

      const bundles = `${releases.length} bundle${releases.length === 1 ? "" : "s"}`;
      await confirmMutation(
        options.nativeBuilds
          ? `Delete the ${channel} channel, its ${bundles}, and its ${builds.length} native build${builds.length === 1 ? "" : "s"} with their artifacts?`
          : `Delete the ${channel} channel and its ${bundles}?`,
        options.yes,
      );
      for (const release of releases) {
        if (release.enabled) {
          await core.updateReleasePolicy({
            expectedRevision: release.revision,
            patch: { enabled: false },
            releaseId: release.id,
          });
        }
        // Core deletes the artifact with the last bundle on it, so a bundle
        // promoted to another channel keeps its files.
        await core.deleteRelease({ releaseId: release.id });
      }
      // Each build's row goes before its artifact, so no row is left naming
      // a deleted artifact; an artifact whose delete fails stays, and the
      // command says where.
      const deletedNativeBuildIds: string[] = [];
      const keptArtifacts: string[] = [];
      for (const build of builds) {
        const deleted = await core.deleteNativeBuild(build.id);
        if (!deleted.deleted) continue;
        deletedNativeBuildIds.push(build.id);
        try {
          await deleteArtifact?.(deleted.nativeBuild.artifact_storage_uri);
        } catch (error) {
          keptArtifacts.push(
            `${deleted.nativeBuild.artifact_storage_uri}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const result = await core.deleteChannel(row.id);
      const deletedBundleIds = releases.map(({ id }) => id);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              channel,
              ...result,
              deletedBundleIds,
              ...(options.nativeBuilds ? { deletedNativeBuildIds } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          ui.block(result.deleted ? "Channel deleted" : "Bundles deleted", [
            ui.kv("Channel", ui.channel(channel)),
            ui.kv("Bundles", String(deletedBundleIds.length)),
            ...(options.nativeBuilds
              ? [ui.kv("Native builds", String(deletedNativeBuildIds.length))]
              : []),
          ]),
        );
      }
      if (keptArtifacts.length > 0) {
        // Under --json, stdout stays one JSON document; stderr says where.
        const message = `The native builds are deleted, but these artifacts stay; delete them from storage:\n${keptArtifacts.join("\n")}`;
        if (options.json) console.error(message);
        else p.log.error(message);
        process.exitCode = 1;
      }
      if (!result.deleted) {
        // Under --json, stdout stays one JSON document: it says why.
        if (!options.json) {
          p.log.error(
            options.nativeBuilds
              ? `The ${channel} channel is kept: a bundle or a native build was added to it meanwhile. Run the command again.`
              : `The ${channel} channel is kept: a native build embeds it as its default channel, or a bundle was deployed to it meanwhile. Run it again with --native-builds to delete the channel's native builds and their artifacts too.`,
          );
        }
        process.exitCode = 1;
        return;
      }
      if (!options.json && deletedBundleIds.length > 0) {
        p.log.info(
          "The stored files stay until `hot-updater storage prune` deletes them.",
        );
      }
    } finally {
      await safeDispose(server);
    }
  });

import { loadConfig, p } from "@hot-updater/cli-tools";
import type { ReleaseRow } from "@hot-updater/plugin-core";
import { createChannelLink } from "@hot-updater/protocol";

import { warnIfExpoCNG } from "@/utils/expoDetection";
import { loadServer } from "@/utils/loadServer";
import { setChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";
import { printBanner } from "../utils/printBanner";
import { withPublicBundleErrors } from "../utils/publicBundleError";
import { confirmMutation, safeDispose } from "./release";

export const handleSetChannel = async (channel: string) => {
  warnIfExpoCNG();
  const { paths: androidPaths } = await setChannel("android", channel);
  p.log.success(ui.line(["Set", ui.platform("Android"), ui.channel(channel)]));
  if (androidPaths.length > 0) {
    p.log.message(
      ui.block(
        "Android paths",
        androidPaths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
      ),
    );
  }

  const { paths: iosPaths } = await setChannel("ios", channel);
  p.log.success(ui.line(["Set", ui.platform("iOS"), ui.channel(channel)]));
  if (iosPaths.length > 0) {
    p.log.message(
      ui.block(
        "iOS paths",
        iosPaths.map((targetPath) => ui.kv("Path", ui.path(targetPath))),
      ),
    );
  }

  p.log.warn("Rebuild native app after changing channel.");
};

/**
 * `value` as one POSIX shell word: as it is when it holds only characters
 * no shell treats specially, else in single quotes. The Console's
 * `lib/shell.ts` quotes the commands it shows the same way.
 */
const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Prints a channel's link, `<console.channelLinkPrefix>hot-updater/channel/
 * <channel>`, the link the Console's QR code of the channel holds, with the
 * `adb` and `xcrun simctl openurl` commands that open it on an emulator or
 * simulator. It reads only the config. `--json` prints `{ channel, link }`,
 * with a null link when the config sets no prefix, and succeeds.
 */
export const handleChannelLink = async (
  channel: string,
  options: { readonly json?: boolean },
) => {
  const config = await loadConfig(null);
  const prefix = config.console?.channelLinkPrefix;
  let link: string | null = null;
  if (prefix !== undefined) {
    try {
      link = createChannelLink(prefix, channel);
    } catch {
      p.log.error(`${JSON.stringify(channel)} is not a channel name.`);
      process.exitCode = 1;
      return;
    }
  }
  if (options.json) {
    console.log(JSON.stringify({ channel, link }));
    return;
  }
  if (link === null) {
    p.log.error(
      "hot-updater.config.ts sets no console.channelLinkPrefix, the prefix of the app's channel links, such as its URL scheme `myapp://`.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    ui.block("Channel link", [
      ui.kv("Channel", ui.channel(channel)),
      ui.kv("Link", link),
      ui.kv(
        "Android",
        ui.command(
          `adb shell am start -a android.intent.action.VIEW -d ${shellQuote(shellQuote(link))}`,
        ),
      ),
      ui.kv(
        "iOS",
        ui.command(`xcrun simctl openurl booted ${shellQuote(link)}`),
      ),
    ]),
  );
};

const PAGE = 100;

/**
 * Deletes a channel with its bundles, as when a pull request's preview
 * channel closes: each bundle is disabled and deleted, then the channel.
 * A missing channel deletes nothing and succeeds, so the cleanup can run
 * again. A native build that embeds the channel keeps it: its bundles are
 * deleted, the channel is not, and the command fails.
 */
export const handleChannelDelete = (
  channel: string,
  options: { readonly json?: boolean; readonly yes?: boolean },
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

      await confirmMutation(
        `Delete the ${channel} channel and its ${releases.length} bundle${releases.length === 1 ? "" : "s"}?`,
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
      const result = await core.deleteChannel(row.id);
      const deletedBundleIds = releases.map(({ id }) => id);

      if (options.json) {
        console.log(
          JSON.stringify({ channel, ...result, deletedBundleIds }, null, 2),
        );
      } else {
        console.log(
          ui.block(result.deleted ? "Channel deleted" : "Bundles deleted", [
            ui.kv("Channel", ui.channel(channel)),
            ui.kv("Bundles", String(deletedBundleIds.length)),
          ]),
        );
      }
      if (!result.deleted) {
        // Under --json, stdout stays one JSON document: it says why.
        if (!options.json) {
          p.log.error(
            `The ${channel} channel is kept: a native build embeds it as its default channel, or a bundle was deployed to it meanwhile. A channel a native build embeds can't be deleted until \`hot-updater native-build delete <id>\` deletes the build, so register preview builds on one shared channel and deploy each pull request to its own.`,
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

import {
  getBundleSigningPublicKey,
  loadConfig,
  p,
} from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  type HotUpdaterCoreApi,
  type Platform,
} from "@hot-updater/plugin-core";
import { isSandboxChannel } from "@hot-updater/protocol/native-artifact";

import { getPlatform } from "@/prompts/getPlatform";
import { createBundleDiff } from "@/utils/createBundleDiff";
import { loadServer } from "@/utils/loadServer";
import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { reportUnexpectedError } from "../utils/reportUnexpectedError";

export interface PatchOptions {
  baseBundleId: string;
  bundleId: string;
  channel: string;
  interactive: boolean;
  platform?: Platform;
}

const NATIVE_BUILD_PAGE = 100;

/**
 * Whether `bundleId` is a sandbox build's built-in bundle, which no patch
 * starts from. Only sandbox builds register on a `sandbox-*` channel, so it
 * pages those channels' builds alone, through routes every server with native
 * builds has: this CLI refuses one whatever the server checks.
 */
const isSandboxBuiltInBundle = async (
  core: HotUpdaterCoreApi,
  bundleId: string,
): Promise<boolean> => {
  const channels = (await core.listChannels()).filter(({ name }) =>
    isSandboxChannel(name),
  );
  for (const channel of channels) {
    for (let after: string | undefined; ; ) {
      const builds = await core.listNativeBuilds({
        channelId: channel.id,
        limit: NATIVE_BUILD_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      if (builds.some(({ min_bundle_id }) => min_bundle_id === bundleId)) {
        return true;
      }
      after = builds.at(-1)?.id;
      if (builds.length < NATIVE_BUILD_PAGE || after === undefined) break;
    }
  }
  return false;
};

export const createPatch = async (options: PatchOptions) => {
  printBanner();

  const platform =
    options.platform ??
    (options.interactive
      ? await getPlatform("Which platform does this patch target?")
      : null);

  if (p.isCancel(platform)) {
    return;
  }

  if (!platform) {
    p.log.error(
      "Platform not found. -p <ios | android> or --platform <ios | android>",
    );
    return;
  }

  const config = await loadConfig({ channel: options.channel, platform });
  const server = await loadServer(config);
  try {
    const storageAdapter = server.storage;
    assertStorageOperations(storageAdapter, ["get", "put", "delete"]);
    p.note(
      ui.block("", [
        ui.kv("Channel", ui.channel(options.channel)),
        ui.kv("Platform", ui.platform(platform)),
        ui.kv("Base artifact ID", ui.id(options.baseBundleId)),
        ui.kv("Target artifact ID", ui.id(options.bundleId)),
      ]),
      "Patch",
    );

    if (await isSandboxBuiltInBundle(server.core, options.baseBundleId)) {
      throw new Error("A sandbox build's built-in bundle is no patch base.");
    }

    await createBundleDiff(
      {
        baseBundleId: options.baseBundleId,
        bundleId: options.bundleId,
      },
      {
        core: server.core,
        signingPublicKey: await getBundleSigningPublicKey(config.signing, {
          secrets: config.secrets,
        }),
        storageAdapter,
      },
      {
        makePrimary: true,
      },
    );

    p.outro("Patch ready.");
  } catch (error) {
    reportUnexpectedError(error);
    process.exit(1);
  } finally {
    await server.dispose();
  }
};

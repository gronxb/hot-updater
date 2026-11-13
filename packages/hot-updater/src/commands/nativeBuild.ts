import fs from "fs";
import os from "os";
import path from "path";

import {
  installOnAndroidDevice,
  listAdbDevices,
  selectAdbDevice,
} from "@hot-updater/android-helper";
import {
  extractSimulatorApp,
  installOnSimulator,
  listSimulators,
  selectSimulator,
} from "@hot-updater/apple-helper";
import { fitText, loadConfig, p } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  type NativeBuildArtifactKind,
  type NativeBuildRow,
  type Platform,
} from "@hot-updater/plugin-core";
import { decodeChannelKey } from "@hot-updater/protocol";
import {
  blobSource,
  createPreviewLink,
  readNativeArtifact,
  sandboxUrlSchemeOf,
} from "@hot-updater/protocol/native-artifact";

import { type Row, ui } from "../utils/cli-ui";
import { formatBytes } from "../utils/formatBytes";
import { type LoadedServer, loadServer } from "../utils/loadServer";
import { describeNativeBuild } from "../utils/native/describeNativeBuild";
import {
  downloadNativeBuild,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  resolveNativeBuildDownloadUrl,
} from "../utils/native/downloadNativeBuild";
import {
  type IosDeviceCoverage,
  readIosDeviceCoverage,
} from "../utils/native/iosDeviceCoverage";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
import { readSchemeAppleDevices } from "../utils/native/schemeAppleDevices";
import { findMissingStorePatch } from "../utils/native/storeBuildPatch";
import {
  applyStoreTestFlightGroup,
  readStoreStatus,
  type StoreStatus,
} from "../utils/native/storeStatus";
import { printBanner } from "../utils/printBanner";
import { confirmMutation, safeDispose } from "./release";

export interface NativeBuildFindOptions {
  readonly platform: Platform;
  /** The channel the build embeds (default: the native project's). */
  readonly channel?: string;
  /**
   * The `nativeBuild` scheme, whose app's version the build would have, and
   * whose kind of artifact a registered build must be.
   */
  readonly scheme?: string;
  /**
   * Asks the store for what a build the project submitted is doing there, for
   * a run that would reuse it. It takes `--scheme`, whose app and key it reads.
   */
  readonly storeStatus?: boolean;
  readonly json?: boolean;
}

/**
 * Finds the newest registered native build that a build of the project
 * would match, as a pull request's preview job does before deciding whether
 * to build: the fingerprint the build would embed, or with the appVersion
 * strategy, the version of the app its scheme builds, on the channel it
 * would embed. With a scheme, the build must also be the kind of artifact
 * the scheme builds: a Simulator scheme can't use an `.ipa`, nor an APK
 * scheme an `.aab`. A sandbox scheme's build is found on any channel, by
 * its app ID, URL scheme, artifact kind and distribution. Under `--json`, a
 * found ad hoc `.ipa` says whether it still installs on the device
 * registry's devices. Printing no build is a result, not a failure.
 */
export const handleNativeBuildFind = async (
  options: NativeBuildFindOptions,
) => {
  if (!options.json) printBanner();
  try {
    // The scheme and the target as the native build loads them.
    const config = await loadConfig({
      platform: options.platform,
      channel: "",
    });
    if (
      options.scheme !== undefined &&
      !(options.scheme in config.nativeBuild[options.platform])
    ) {
      throw new Error(
        `scheme ${options.scheme} is not in nativeBuild.${options.platform} in hot-updater.config.ts.`,
      );
    }
    if (options.storeStatus && options.scheme === undefined) {
      throw new Error(
        "--store-status reads the store's app of a scheme.\nPass --scheme.",
      );
    }
    const scope = await resolveNativeBuildScope(config, options);
    const artifactKind =
      options.scheme === undefined
        ? undefined
        : schemeArtifactKind(config, options.platform, options.scheme);
    const sandbox =
      options.scheme === undefined
        ? null
        : schemeSandbox(config, options.platform, options.scheme);

    // The registry `native-build ios|android` tracks builds in.
    const server = await loadServer(await loadConfig(null));
    let nativeBuild: NativeBuildRow | null;
    let downloadUrl: string | null = null;
    let iosDevices: IosDeviceCoverage | null = null;
    try {
      // The scheme's kind, so a newer build of another kind of the scope,
      // such as its Simulator .app beside its .ipa, hides nothing.
      nativeBuild =
        artifactKind === undefined
          ? await server.core.findNativeBuild(scope)
          : await server.core.findNativeBuild(scope, { artifactKind });
      if (
        nativeBuild !== null &&
        artifactKind !== undefined &&
        nativeBuild.artifact_kind !== artifactKind
      ) {
        nativeBuild = null;
      }
      if (options.json && nativeBuild !== null) {
        downloadUrl = await resolveNativeBuildDownloadUrl(
          server.storage,
          nativeBuild,
        );
      }
      if (options.json && nativeBuild !== null) {
        const { scheme } = options;
        iosDevices = await readIosDeviceCoverage(
          server,
          nativeBuild,
          // A credential this run can't resolve reads as Apple's state
          // unknown: the build waits, rather than building on a guess.
          async () =>
            scheme === undefined || options.platform !== "ios"
              ? {
                  kind: "unavailable",
                  reason: "no nativeBuild.ios scheme names its Apple account",
                }
              : readSchemeAppleDevices(config, scheme),
        ).catch((error) => {
          // Without the registry or the artifact, the run decides as before.
          console.error(
            fitText(
              `Couldn't check the build's devices: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return null;
        });
      }
    } finally {
      await safeDispose(server);
    }

    const store: StoreStatus | null =
      options.storeStatus && nativeBuild?.submitted_to
        ? await readStoreStatus(config, {
            platform: options.platform,
            scheme: options.scheme!,
            build: nativeBuild,
            onError: (error) => {
              const message = `Couldn't read the store's status of the build.\n${error instanceof Error ? error.message : String(error)}`;
              if (options.json) console.error(fitText(message));
              else p.log.warn(message);
            },
          })
        : null;

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...scope,
            nativeBuild,
            downloadUrl,
            ...(options.storeStatus ? { store } : {}),
            ...(iosDevices === null ? {} : { iosDevices }),
            ...(sandbox === null
              ? {}
              : {
                  sandbox: {
                    appId: sandbox.appId,
                    urlScheme: sandboxUrlSchemeFor(sandbox, nativeBuild),
                    // The channel the found build embeds, which may be
                    // another pull request's.
                    channel:
                      nativeBuild === null ? null : channelNameOf(nativeBuild),
                  },
                }),
          },
          null,
          2,
        ),
      );
      return;
    }
    const target: Row =
      scope.fingerprintHash === null
        ? ui.kv("App version", ui.version(scope.appVersion))
        : ui.kv("Fingerprint", ui.id(scope.fingerprintHash));
    if (nativeBuild === null) {
      p.log.info(
        ui.block("No native build matches", [
          ui.kv("Platform", ui.platform(scope.platform)),
          ui.kv("Channel", ui.channel(scope.channel)),
          target,
        ]),
      );
      return;
    }
    p.log.success(
      ui.block("Native build found", [
        ui.kv("ID", ui.id(nativeBuild.id)),
        ui.kv("Platform", ui.platform(scope.platform)),
        // A sandbox build found on another pull request's channel says so.
        ui.kv(
          "Channel",
          ui.channel(channelNameOf(nativeBuild) ?? scope.channel),
        ),
        target,
        artifactVersionRow(nativeBuild),
        ui.kv("Kind", kindOf(nativeBuild)),
        ui.kv("Min bundle ID", ui.id(nativeBuild.min_bundle_id)),
        ui.kv("Created", formatUtc(nativeBuild.created_at_ms)),
        store !== null &&
          ui.kv(
            "Store",
            [store.version, store.state, store.url]
              .filter((part) => part !== null)
              .join(" · "),
          ),
      ]),
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

/**
 * A fingerprint build's own app version, which the artifact reports: an app
 * version build's is its target, already shown.
 */
const artifactVersionRow = (
  build: Pick<NativeBuildRow, "fingerprint_hash" | "native_app_version">,
) =>
  build.fingerprint_hash !== null &&
  Boolean(build.native_app_version) &&
  ui.kv("App version", ui.version(build.native_app_version!));

/** The build's artifact kind, `apk · sandbox` for a sandbox build. */
const kindOf = (build: Pick<NativeBuildRow, "artifact_kind" | "is_sandbox">) =>
  build.is_sandbox ? `${build.artifact_kind} · sandbox` : build.artifact_kind;

/** `2026-10-27 04:02 UTC`. */
const formatUtc = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The kind of artifact `native-build <platform> --scheme <scheme>` builds. */
const schemeArtifactKind = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  platform: Platform,
  scheme: string,
): NativeBuildArtifactKind =>
  platform === "android"
    ? (config.nativeBuild.android[scheme]?.aab ?? true)
      ? "aab"
      : "apk"
    : config.nativeBuild.ios[scheme]?.simulator
      ? "app"
      : "ipa";

/**
 * What a sandbox scheme's links are made from, or null for any other scheme:
 * the configured app ID, before Android's `.sandbox` suffix, and the URL
 * scheme a build of the config registers.
 */
const schemeSandbox = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  platform: Platform,
  scheme: string,
): { appId: string; urlScheme: string } | null => {
  const entry =
    platform === "android"
      ? config.nativeBuild.android[scheme]
      : config.nativeBuild.ios[scheme];
  if (!entry?.sandbox) return null;
  const appId =
    "packageName" in entry ? entry.packageName : entry.bundleIdentifier;
  return {
    appId,
    urlScheme: entry.sandboxUrlScheme ?? sandboxUrlSchemeOf(appId),
  };
};

/**
 * The URL scheme a sandbox scheme's links open: the matched build's, which a
 * build keeps whatever the config says now, or, with none matched, the one a
 * build of the config registers. A build registered before its scheme was
 * recorded registered the one derived from the app's ID.
 */
const sandboxUrlSchemeFor = (
  sandbox: { appId: string; urlScheme: string },
  nativeBuild: NativeBuildRow | null,
): string =>
  nativeBuild === null
    ? sandbox.urlScheme
    : (nativeBuild.sandbox_url_scheme ?? sandboxUrlSchemeOf(sandbox.appId));

/** The name of the channel a build embeds, from its row's channel key. */
const channelNameOf = (
  build: Pick<NativeBuildRow, "channel_id">,
): string | null => {
  const key = build.channel_id.replace(/^channel:/u, "");
  try {
    return decodeChannelKey(key);
  } catch {
    return null;
  }
};

/** Prints why a command failed, on stderr under `--json`, and exits. */
const failCommand = (error: unknown, json: boolean | undefined) => {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.error(fitText(message));
  else p.log.error(message);
  process.exit(1);
};

const nativeBuildNotFound = (id: string) =>
  new Error(
    `No native build ${id}.\nFind one: npx hot-updater native-build find -p <platform>`,
  );

const requireNativeBuild = async (
  server: LoadedServer,
  id: string,
): Promise<NativeBuildRow> => {
  const build = await server.core.getNativeBuild(id);
  if (build === null) throw nativeBuildNotFound(id);
  return build;
};

/**
 * Adds a sandbox build already on TestFlight to an internal group, with no new
 * upload, and prints what App Store Connect says of the build.
 */
export const handleNativeBuildTestFlightGroup = async (
  id: string,
  group: string,
  options: { readonly scheme: string; readonly json?: boolean },
) => {
  if (!options.json) printBanner();
  try {
    const config = await loadConfig({ platform: "ios", channel: "" });
    if (!config.nativeBuild.ios[options.scheme]?.sandbox) {
      throw new Error(
        `testflight-group takes a sandbox scheme, and ${options.scheme} isn't one.\nSet sandbox: true on it, or add the build to ${group} in TestFlight.`,
      );
    }
    const server = await loadServer(await loadConfig(null));
    let build: NativeBuildRow;
    try {
      build = await requireNativeBuild(server, id);
    } finally {
      await safeDispose(server);
    }
    if (build.submitted_to !== "testflight") {
      throw new Error(
        `Native build ${id} isn't on TestFlight.\nUpload one: npx hot-updater native-build ios --scheme ${options.scheme} --submit testflight`,
      );
    }
    const store = await applyStoreTestFlightGroup(config, {
      scheme: options.scheme,
      build,
      group,
    });
    if (options.json) {
      console.log(JSON.stringify(store, null, 2));
      return;
    }
    const line = {
      added: `Added ${store.version} to ${group}.`,
      "takes-every-build": `${group} takes every build, so it has ${store.version}.`,
      pending: `${store.version} is still processing, so ${group} doesn't have it yet.`,
      "not-offered": `TestFlight no longer offers ${store.version}, so ${group} didn't get it.`,
    }[store.group];
    if (store.group === "added" || store.group === "takes-every-build") {
      p.log.success(line);
    } else {
      p.log.warn(line);
      process.exitCode = 1;
    }
  } catch (error) {
    failCommand(error, options.json);
  }
};

export interface NativeBuildDownloadOptions {
  /** The file or directory to write: the artifact's name in the current directory without one. */
  readonly output?: string;
  readonly json?: boolean;
}

/**
 * Downloads a registered native build's artifact through the config's
 * storage, with no Console and no download URL, so it works on every storage
 * that can read its objects.
 */
export const handleNativeBuildDownload = async (
  id: string,
  options: NativeBuildDownloadOptions,
) => {
  if (!options.json) printBanner();
  try {
    const server = await loadServer(await loadConfig(null));
    try {
      const build = await requireNativeBuild(server, id);
      const file = nativeBuildDownloadPath(build, options.output);
      const { byteSize } = await downloadNativeBuild(
        server.storage,
        build,
        file,
      );
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              id,
              platform: build.platform,
              kind: build.artifact_kind,
              path: file,
              byteSize,
            },
            null,
            2,
          ),
        );
        return;
      }
      p.log.success(
        ui.block("Native build downloaded", [
          ui.kv("ID", ui.id(id)),
          ui.kv("Kind", kindOf(build)),
          ui.kv("Size", formatBytes(byteSize)),
          ui.kv("File", ui.path(ui.fitPath(file))),
        ]),
      );
    } finally {
      await safeDispose(server);
    }
  } catch (error) {
    failCommand(error, options.json);
  }
};

/** Why an artifact installs from no file here, and its next step. */
const NOT_INSTALLABLE: Partial<Record<NativeBuildArtifactKind, string>> = {
  ipa: "An .ipa installs only on devices its signing profile allows, through Xcode or Apple Configurator.\nFor testers: npx hot-updater testflight",
  aab: "An .aab installs through Google Play or bundletool, not from the file.\nFor testers: npx hot-updater google-play upload",
};

export interface NativeBuildInstallOptions {
  /** The booted iOS Simulator's UDID, for a simulator build. */
  readonly simulator?: string;
  /** The Android device's serial, as `adb devices` lists it, for an APK. */
  readonly device?: string;
  /**
   * A channel a sandbox Simulator build opens instead of its own: its
   * preview link, which a QR code holds on a phone.
   */
  readonly open?: string;
  readonly json?: boolean;
}

/**
 * Why `--open` can't open a channel in a build: only a sandbox Simulator
 * build of a fingerprint has a preview link to open; null when it can.
 */
const openRefusal = (build: NativeBuildRow): string | null =>
  build.artifact_kind !== "app"
    ? "--open opens a channel in a Simulator build."
    : !build.is_sandbox
      ? "This build opens the channel it embeds.\nLeave out --open."
      : build.fingerprint_hash === null
        ? "A preview link names a fingerprint, and this build has an app version.\nLeave out --open, and open the channel in the app."
        : null;

/** A sandbox build's preview link of `channel`, of the URL scheme it registered. */
const previewLinkOf = (build: NativeBuildRow, channel: string, appId: string) =>
  createPreviewLink({
    urlScheme: build.sandbox_url_scheme ?? sandboxUrlSchemeOf(appId),
    channel,
    fingerprintHash: build.fingerprint_hash!,
    platform: build.platform,
  });

/**
 * Downloads a registered simulator `.app` or `.apk`, installs it on a booted
 * simulator or a connected Android device, and opens it. The app is the one
 * the artifact itself names, so a build with an application ID of its own,
 * such as a sandbox build's `.sandbox`, installs beside the store app the same
 * way. The device is checked first, so one that isn't there costs no download.
 */
export const handleNativeBuildInstall = async (
  id: string,
  options: NativeBuildInstallOptions,
) => {
  if (!options.json) printBanner();
  try {
    const server = await loadServer(await loadConfig(null));
    let directory: string | undefined;
    try {
      const build = await requireNativeBuild(server, id);
      const notInstallable = NOT_INSTALLABLE[build.artifact_kind];
      if (notInstallable !== undefined) throw new Error(notInstallable);
      const { open } = options;
      if (open !== undefined) {
        const refusal = openRefusal(build);
        if (refusal !== null) throw new Error(refusal);
        // A channel no link can name fails before anything downloads.
        previewLinkOf(build, open, build.sandbox_url_scheme ?? "app");
      }
      const isSimulatorApp = build.artifact_kind === "app";
      if (isSimulatorApp ? options.device : options.simulator) {
        throw new Error(
          isSimulatorApp
            ? "This is a simulator build, and --device picks an Android device.\nPick a simulator with --simulator <udid>."
            : "This is an Android build, and --simulator picks an iOS Simulator.\nPick a device with --device <serial>.",
        );
      }
      const target = isSimulatorApp
        ? selectSimulator(await listSimulators(), options.simulator)
        : selectAdbDevice(await listAdbDevices(), options.device);
      const targetId = "udid" in target ? target.udid : target.serial;

      directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-install-"),
      );
      // The artifact's name says its kind to the reader, whatever it is stored as.
      const artifact = path.join(
        directory,
        isSimulatorApp ? "artifact.app.zip" : "artifact.apk",
      );
      if (!options.json) {
        p.log.step(
          ui.line([
            "Downloading",
            nativeBuildFileName(build),
            ui.muted(formatBytes(build.byte_size)),
          ]),
        );
      }
      await downloadNativeBuild(server.storage, build, artifact);
      const { appId } = await readNativeArtifact(
        blobSource(await fs.openAsBlob(artifact)),
        path.basename(artifact),
      );
      if (appId === null) {
        throw new Error("The artifact names no app to open.");
      }

      if (isSimulatorApp) {
        await installOnSimulator({
          udid: targetId,
          appPath: await extractSimulatorApp({
            archivePath: artifact,
            outputPath: path.join(directory, "app"),
          }),
          appId,
          ...(open === undefined
            ? {}
            : { url: previewLinkOf(build, open, appId) }),
        });
      } else {
        await installOnAndroidDevice({
          serial: targetId,
          apkPath: artifact,
          appId,
        });
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              id,
              platform: build.platform,
              device: targetId,
              appId,
              ...(open === undefined ? {} : { channel: open }),
            },
            null,
            2,
          ),
        );
        return;
      }
      p.log.success(
        ui.block("Native build installed and opened", [
          ui.kv("ID", ui.id(id)),
          ui.kv("App", appId),
          open !== undefined && ui.kv("Channel", ui.channel(open)),
          "udid" in target
            ? ui.kv("Simulator", `${target.name} (${target.udid})`)
            : ui.kv("Device", target.serial),
        ]),
      );
    } finally {
      if (directory !== undefined) {
        await fs.promises.rm(directory, { force: true, recursive: true });
      }
      await safeDispose(server);
    }
  } catch (error) {
    failCommand(error, options.json);
  }
};

/**
 * Deletes a registered native build: its row and its built-in bundle's in
 * the database, then its artifact in storage, which no `storage prune`
 * reclaims. The row goes first, so no row is left naming a deleted
 * artifact; an artifact whose delete fails stays, and the command prints
 * where. A build that is not registered deletes nothing and succeeds, so
 * the cleanup can run again.
 */
export const handleNativeBuildDelete = async (
  id: string,
  options: { readonly json?: boolean; readonly yes?: boolean },
) => {
  if (!options.json) printBanner();
  const notFound = () => {
    if (options.json) {
      console.log(JSON.stringify({ id, deleted: false, reason: "not_found" }));
    } else {
      p.log.step(ui.line(["No native build", ui.id(id), "to delete"]));
    }
  };
  try {
    const server = await loadServer(await loadConfig(null));
    try {
      // Checked before anything is deleted, so no artifact is left behind.
      assertStorageOperations(server.storage, ["delete"]);
      const core = server.core;
      const build = await core.getNativeBuild(id);
      if (build === null) return notFound();
      const channel =
        (await core.listChannels()).find(({ id }) => id === build.channel_id)
          ?.name ?? build.channel_id;

      if (!options.json) {
        p.log.step(
          ui.block("Native build", [
            ui.kv("ID", ui.id(build.id)),
            ui.kv("Platform", ui.platform(build.platform)),
            ui.kv("Channel", ui.channel(channel)),
            build.fingerprint_hash === null
              ? ui.kv("App version", ui.version(build.app_version))
              : ui.kv("Fingerprint", ui.id(build.fingerprint_hash)),
            artifactVersionRow(build),
            ui.kv("Kind", kindOf(build)),
            ui.kv("Size", formatBytes(build.byte_size)),
            ui.kv("Artifact", ui.path(ui.fitPath(build.artifact_storage_uri))),
            build.is_store_build &&
              "This is the scope's store build; deploys go back to the newest build.",
          ]),
        );
      }
      await confirmMutation(
        "Delete this native build and its artifact?",
        options.yes,
      );

      const result = await core.deleteNativeBuild(id);
      if (!result.deleted) return notFound();

      let artifactError: unknown;
      try {
        await server.storage.delete({
          storageUri: result.nativeBuild.artifact_storage_uri,
        });
      } catch (error) {
        artifactError = error;
      }
      const artifactDeleted = artifactError === undefined;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              id,
              deleted: true,
              nativeBuild: result.nativeBuild,
              artifactDeleted,
            },
            null,
            2,
          ),
        );
      } else {
        p.log.success(
          ui.block("Native build deleted", [
            ui.kv("ID", ui.id(id)),
            ui.kv("Platform", ui.platform(build.platform)),
            ui.kv("Channel", ui.channel(channel)),
          ]),
        );
      }
      if (!artifactDeleted) {
        // Under --json, stdout stays one JSON document: it says the artifact
        // stays, and stderr says where and why.
        const reason =
          artifactError instanceof Error
            ? artifactError.message
            : String(artifactError);
        const message = [
          "The native build is deleted, but its artifact is not.",
          reason,
          `Delete ${result.nativeBuild.artifact_storage_uri} from storage.`,
        ].join("\n");
        if (options.json) console.error(fitText(message));
        else p.log.error(message);
        process.exitCode = 1;
        return;
      }
    } finally {
      await safeDispose(server);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

/** Why `native-build mark` refused a build, for its `--json` output. */
class MarkRefusal extends Error {
  constructor(
    readonly reason: "not_found" | "sandbox_build",
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Marks a build as what the store sells, or clears its mark. A new mark
 * changes no published OTA: when the OTA a fresh install gets first has no
 * patch from the build, it prints the command that adds one. Running it again
 * changes nothing, for CI.
 */
export const handleNativeBuildMark = async (
  id: string,
  options: { readonly clear?: boolean; readonly json?: boolean },
) => {
  if (!options.json) printBanner();
  try {
    const config = await loadConfig(null);
    const server = await loadServer(config);
    try {
      let marked: Awaited<ReturnType<typeof server.core.markNativeBuild>>;
      try {
        marked = await server.core.markNativeBuild(id, {
          storeBuild: !options.clear,
        });
      } catch (error) {
        // Core's refusal has no public class, and a standalone server sends
        // it as a 400, so the build, read only on this path, tells it.
        const build = await server.core.getNativeBuild(id).catch(() => null);
        if (build?.is_sandbox) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new MarkRefusal(
            "sandbox_build",
            new Error(
              [
                message,
                "Mark a build of a scheme without sandbox: true. Find one:",
                `npx hot-updater native-build find -p ${build.platform} -s <scheme>`,
              ].join("\n"),
            ),
          );
        }
        throw error;
      }
      if (marked === null) {
        throw new MarkRefusal("not_found", nativeBuildNotFound(id));
      }
      const { nativeBuild, previous } = marked;
      const label = describeNativeBuild(nativeBuild);
      // Deploys with patches off add none either, so nothing is missing.
      const missingPatch =
        options.clear || !config.patch?.enabled
          ? null
          : await findMissingStorePatch(server.core, nativeBuild);
      if (options.json) {
        console.log(JSON.stringify({ nativeBuild, previous, missingPatch }));
        return;
      }
      p.log.success(
        options.clear
          ? `${label} isn't the store build`
          : [
              `${label} is the store build`,
              previous !== null && `Replaces ${describeNativeBuild(previous)}`,
            ]
              .filter(Boolean)
              .join("\n"),
      );
      if (missingPatch !== null) {
        p.log.warn(
          `OTA ${missingPatch.bundleId.slice(0, 8)} has no patch from it, so fresh installs download all of it.\n${missingPatch.command}`,
        );
      }
    } finally {
      await safeDispose(server);
    }
  } catch (error) {
    if (!(error instanceof MarkRefusal))
      return failCommand(error, options.json);
    // Under --json, a refused mark is still one JSON document
    // on stdout, with a reason a CI job can test, and the command fails.
    if (options.json) {
      console.log(
        JSON.stringify({
          id,
          [options.clear ? "cleared" : "marked"]: false,
          reason: error.reason,
        }),
      );
    }
    // Laid out one idea per line, so its command line is highlighted whole.
    const message = ui.prose(error.message);
    if (options.json) console.error(message);
    else p.log.error(message);
    process.exit(1);
  }
};

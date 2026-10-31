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
import {
  blobSource,
  readNativeArtifact,
} from "@hot-updater/protocol/native-artifact";

import { type Row, ui } from "../utils/cli-ui";
import { formatBytes } from "../utils/formatBytes";
import { type LoadedServer, loadServer } from "../utils/loadServer";
import {
  downloadNativeBuild,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  resolveNativeBuildDownloadUrl,
} from "../utils/native/downloadNativeBuild";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
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
 * scheme an `.aab`. Printing no build is a result, not a failure.
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

    // The registry `native-build ios|android` tracks builds in.
    const server = await loadServer(await loadConfig(null));
    let nativeBuild: NativeBuildRow | null;
    let downloadUrl: string | null = null;
    try {
      nativeBuild = await server.core.findNativeBuild(scope);
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
        ui.kv("Channel", ui.channel(scope.channel)),
        target,
        ui.kv("Kind", nativeBuild.artifact_kind),
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

/** Prints why a command failed, on stderr under `--json`, and exits. */
const failCommand = (error: unknown, json: boolean | undefined) => {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.error(fitText(message));
  else p.log.error(message);
  process.exit(1);
};

const requireNativeBuild = async (
  server: LoadedServer,
  id: string,
): Promise<NativeBuildRow> => {
  const build = await server.core.getNativeBuild(id);
  if (build === null) {
    throw new Error(
      `No native build ${id}.\nFind one: npx hot-updater native-build find -p <platform>`,
    );
  }
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
          ui.kv("Kind", build.artifact_kind),
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
  readonly json?: boolean;
}

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
            { id, platform: build.platform, device: targetId, appId },
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
            ui.kv("Kind", build.artifact_kind),
            ui.kv("Size", formatBytes(build.byte_size)),
            ui.kv("Artifact", ui.path(ui.fitPath(build.artifact_storage_uri))),
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

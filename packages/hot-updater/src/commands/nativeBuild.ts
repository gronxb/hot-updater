import { fitText, loadConfig, p } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  type NativeBuildArtifactKind,
  type NativeBuildRow,
  type Platform,
} from "@hot-updater/plugin-core";

import { type Row, ui } from "../utils/cli-ui";
import { formatBytes } from "../utils/formatBytes";
import { loadServer } from "../utils/loadServer";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
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
    const scope = await resolveNativeBuildScope(config, options);
    const artifactKind =
      options.scheme === undefined
        ? undefined
        : schemeArtifactKind(config, options.platform, options.scheme);

    // The registry `native-build ios|android` tracks builds in.
    const server = await loadServer(await loadConfig(null));
    let nativeBuild: NativeBuildRow | null;
    try {
      nativeBuild = await server.core.findNativeBuild(scope);
    } finally {
      await safeDispose(server);
    }
    if (
      nativeBuild !== null &&
      artifactKind !== undefined &&
      nativeBuild.artifact_kind !== artifactKind
    ) {
      nativeBuild = null;
    }

    if (options.json) {
      console.log(JSON.stringify({ ...scope, nativeBuild }, null, 2));
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

import fs from "node:fs/promises";
import path from "node:path";

import type {
  BasePluginArgs,
  BuildPlugin,
  BuildPluginConfig,
  NativeFingerprintProvider,
} from "@hot-updater/plugin-core";
import {
  compareStringsByCodeUnit,
  getUtf8ByteSize,
  MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES,
} from "@hot-updater/plugin-core";
import { uuidv7 } from "uuidv7";

import { createLynxNativeFingerprint } from "./buildFingerprint";

export const MAX_LYNX_SIDECAR_BYTES = 16 * 1024;
// This leaves room for worst-case JSON escaping and a maximum-size entry path.
export const MAX_LYNX_RUNTIME_ID_UTF8_BYTES = 2 * 1024;

export interface LynxBuildContext {
  readonly cwd: string;
  readonly platform: "ios" | "android";
  readonly bundleId: string;
  /** Empty directory owned by this attempt. Write all runtime assets here. */
  readonly outDir: string;
}

export interface LynxBuildOutput {
  /** POSIX path to the native Lynx entry, relative to outDir. */
  readonly entry: string;
  /** Exact compatibility identity embedded by the target native binary. */
  readonly runtimeId: string;
  readonly stdout?: string | null;
}

export interface LynxPluginConfig extends BuildPluginConfig {
  /** Compile or copy native Lynx output using the app's own toolchain. */
  build: (context: LynxBuildContext) => Promise<LynxBuildOutput>;
  /** Resolve the public key embedded by the native build, or null when unsigned. */
  getBundleSigningPublicKey?: (context: BasePluginArgs) => Promise<{
    readonly publicKey: string;
  } | null>;
  /** Override native compatibility fingerprinting for a custom Lynx host. */
  fingerprint?: NativeFingerprintProvider;
}

const isSubdirectory = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const isRelativeFilePath = (value: string): boolean =>
  !!value &&
  !value.includes("\\") &&
  !value.includes(":") &&
  !path.posix.isAbsolute(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

/** Packages native Lynx output without depending on a UI framework or compiler. */
export const lynx =
  ({
    build,
    fingerprint,
    getBundleSigningPublicKey,
    outDir = ".hot-updater/lynx",
  }: LynxPluginConfig) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => ({
    name: "lynx",
    nativeBuild: {
      fingerprint: (options) =>
        fingerprint
          ? fingerprint(options)
          : createLynxNativeFingerprint(cwd, options),
      signingConfigSource: "build-plugin",
      getBundleSigningPublicKey: async () =>
        getBundleSigningPublicKey ? getBundleSigningPublicKey({ cwd }) : null,
    },
    build: async ({ platform }) => {
      if (platform !== "ios" && platform !== "android") {
        throw new Error("Lynx builds require ios or android.");
      }
      const outputRoot = path.resolve(cwd, outDir);
      if (!isSubdirectory(path.resolve(cwd), outputRoot)) {
        throw new Error("Lynx outDir must be a subdirectory of the app.");
      }

      const bundleId = uuidv7();
      await fs.mkdir(outputRoot, { recursive: true });
      if (
        !isSubdirectory(await fs.realpath(cwd), await fs.realpath(outputRoot))
      ) {
        throw new Error("Lynx outDir must be a subdirectory of the app.");
      }
      const buildPath = await fs.mkdtemp(path.join(outputRoot, `${platform}-`));
      try {
        const {
          entry,
          runtimeId,
          stdout = null,
        } = await build({
          cwd,
          platform,
          bundleId,
          outDir: buildPath,
        });
        if (typeof entry !== "string" || !isRelativeFilePath(entry)) {
          throw new Error(
            "Lynx entry must be a relative file path inside outDir.",
          );
        }
        if (getUtf8ByteSize(entry) > MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES) {
          throw new Error(
            `Lynx entry exceeds ${MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES} UTF-8 bytes.`,
          );
        }
        if (typeof runtimeId !== "string" || !runtimeId.trim()) {
          throw new Error(
            "Lynx output must declare its native compatibility identity.",
          );
        }
        if (getUtf8ByteSize(runtimeId) > MAX_LYNX_RUNTIME_ID_UTF8_BYTES) {
          throw new Error(
            `Lynx runtime identity exceeds ${MAX_LYNX_RUNTIME_ID_UTF8_BYTES} UTF-8 bytes.`,
          );
        }
        const files = await fs.readdir(buildPath, { recursive: true });
        for (const file of files) {
          if (
            ["manifest.json", "hot-updater-lynx.json"].includes(
              file.toLowerCase(),
            )
          ) {
            throw new Error(`Lynx output contains reserved metadata: ${file}`);
          }
          if (!isRelativeFilePath(file)) {
            throw new Error(
              `Lynx output contains an invalid relative path: ${file}`,
            );
          }
          const stat = await fs.lstat(path.join(buildPath, file));
          if (stat.isSymbolicLink()) {
            throw new Error("Lynx artifacts must not contain symbolic links.");
          }
          if (!stat.isFile() && !stat.isDirectory()) {
            throw new Error(`Lynx output contains a nonregular file: ${file}`);
          }
        }
        const entryStat = await fs.stat(path.join(buildPath, entry));
        if (!entryStat.isFile() || entryStat.size === 0) {
          throw new Error("Lynx entry must be a non-empty file.");
        }
        const sidecar = `${JSON.stringify({ schemaVersion: 1, bundleId, platform, entry, runtimeId }, null, 2)}\n`;
        if (Buffer.byteLength(sidecar) > MAX_LYNX_SIDECAR_BYTES) {
          throw new Error(
            `Lynx metadata exceeds ${MAX_LYNX_SIDECAR_BYTES} bytes.`,
          );
        }
        await fs.writeFile(
          path.join(buildPath, "hot-updater-lynx.json"),
          sidecar,
          {
            flag: "wx",
          },
        );
        const artifactNames: string[] = [];
        for (const name of await fs.readdir(buildPath, { recursive: true })) {
          if ((await fs.lstat(path.join(buildPath, name))).isFile()) {
            artifactNames.push(name.split(path.sep).join("/"));
          }
        }
        artifactNames.sort(compareStringsByCodeUnit);
        const artifacts = artifactNames.map((name) => ({
          path: path.join(buildPath, name),
          name,
          downloadCompression: name === entry ? ("br" as const) : null,
        }));
        return {
          artifacts,
          buildPath,
          bundleId,
          patchAssetPath: entry,
          stdout,
        };
      } catch (error) {
        await fs.rm(buildPath, { recursive: true, force: true });
        throw error;
      }
    },
  });

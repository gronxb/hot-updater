import fs from "node:fs/promises";
import path from "node:path";

import type {
  BasePluginArgs,
  BuildPlugin,
  BuildPluginConfig,
} from "@hot-updater/plugin-core";
import { uuidv7 } from "uuidv7";

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
    getBundleSigningPublicKey,
    outDir = ".hot-updater/lynx",
  }: LynxPluginConfig) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => ({
    name: "lynx",
    nativeBuild: {
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
        if (typeof runtimeId !== "string" || !runtimeId.trim()) {
          throw new Error(
            "Lynx output must declare its native compatibility identity.",
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
        await fs.writeFile(
          path.join(buildPath, "hot-updater-lynx.json"),
          `${JSON.stringify({ schemaVersion: 1, bundleId, platform, entry, runtimeId }, null, 2)}\n`,
          { flag: "wx" },
        );
        return { buildPath, bundleId, filePolicy: "preserve", stdout };
      } catch (error) {
        await fs.rm(buildPath, { recursive: true, force: true });
        throw error;
      }
    },
  });

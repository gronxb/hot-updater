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
  findPortableArtifactPathConflict,
  getPortableArtifactPathCollisionKey,
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
  /** Complete, deterministic allowlist of full-page Lynx entries. */
  readonly pageEntries: readonly string[];
  /** Resources required before each page can be admitted as ready. */
  readonly pageEssentialResources: readonly LynxPageEssentialResources[];
  /** Exact compatibility identity embedded by the target native binary. */
  readonly runtimeId: string;
  /** Optional identity that must match a native embedded Bundle. */
  readonly bundleId?: string;
  readonly stdout?: string | null;
}

export interface LynxPageEssentialResources {
  readonly entry: string;
  readonly resources: readonly string[];
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

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const isRelativeFilePath = (value: string): boolean =>
  !!value &&
  !value.includes("\\") &&
  !value.includes(":") &&
  !hasControlCharacter(value) &&
  !path.posix.isAbsolute(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

const PAGE_ENTRY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.lynx\.bundle$/;

const assertPortablePath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !isRelativeFilePath(value)) {
    throw new Error(`${label} must be a relative file path inside outDir.`);
  }
  if (getUtf8ByteSize(value) > MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
};

const assertCanonicalOrder = (values: readonly string[], label: string) => {
  const sorted = [...values].sort(compareStringsByCodeUnit);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${label} must use locale-independent UTF-16 order.`);
  }
};

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

      let bundleId = uuidv7();
      await fs.mkdir(outputRoot, { recursive: true });
      if (
        !isSubdirectory(await fs.realpath(cwd), await fs.realpath(outputRoot))
      ) {
        throw new Error("Lynx outDir must be a subdirectory of the app.");
      }
      const buildPath = await fs.mkdtemp(path.join(outputRoot, `${platform}-`));
      try {
        const compiled = await build({
          cwd,
          platform,
          bundleId,
          outDir: buildPath,
        });
        const {
          entry,
          pageEntries,
          pageEssentialResources,
          runtimeId,
          stdout = null,
        } = compiled;
        if (compiled.bundleId !== undefined && compiled.bundleId !== bundleId) {
          if (
            typeof compiled.bundleId !== "string" ||
            compiled.bundleId.length === 0
          ) {
            throw new Error("Lynx output bundle identity is invalid.");
          }
          bundleId = compiled.bundleId;
        }
        assertPortablePath(entry, "Lynx entry");
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
        const outputNames = await fs.readdir(buildPath, { recursive: true });
        const portableOutputNames: string[] = [];
        const artifactNames: string[] = [];
        const artifactStats = new Map<
          string,
          Awaited<ReturnType<typeof fs.lstat>>
        >();
        for (const outputName of outputNames) {
          const name = outputName.split(path.sep).join("/");
          assertPortablePath(name, "Lynx output path");
          portableOutputNames.push(name);
          const stat = await fs.lstat(path.join(buildPath, outputName));
          if (stat.isSymbolicLink()) {
            throw new Error("Lynx artifacts must not contain symbolic links.");
          }
          if (!stat.isFile() && !stat.isDirectory()) {
            throw new Error(`Lynx output contains a nonregular file: ${name}`);
          }
          if (stat.isFile()) {
            artifactNames.push(name);
            artifactStats.set(name, stat);
          }
        }

        const pathConflict = findPortableArtifactPathConflict(artifactNames);
        if (pathConflict) {
          const [first, second] =
            "first" in pathConflict
              ? [pathConflict.first, pathConflict.second]
              : [pathConflict.ancestor, pathConflict.descendant];
          throw new Error(
            `Lynx output contains a portable path collision: ${first}, ${second}`,
          );
        }
        const reservedKeys = new Set(
          ["manifest.json", "hot-updater-lynx.json"].map(
            getPortableArtifactPathCollisionKey,
          ),
        );
        const reservedName = portableOutputNames.find((name) =>
          reservedKeys.has(getPortableArtifactPathCollisionKey(name)),
        );
        if (reservedName) {
          throw new Error(
            `Lynx output contains reserved metadata: ${reservedName}`,
          );
        }

        if (!Array.isArray(pageEntries) || pageEntries.length === 0) {
          throw new Error("Lynx output must declare at least one page entry.");
        }
        const validatedPageEntries = pageEntries.map((pageEntry) => {
          const value = assertPortablePath(pageEntry, "Lynx page entry");
          if (!PAGE_ENTRY_PATTERN.test(value)) {
            throw new Error(
              `Lynx page entry does not use the canonical page route grammar: ${value}`,
            );
          }
          return value;
        });
        assertCanonicalOrder(validatedPageEntries, "Lynx page entries");
        const pageConflict =
          findPortableArtifactPathConflict(validatedPageEntries);
        if (pageConflict) {
          throw new Error("Lynx page entries must be collision-free.");
        }
        if (
          validatedPageEntries.filter((pageEntry) => pageEntry === entry)
            .length !== 1
        ) {
          throw new Error(
            "Lynx page entries must contain the main entry exactly once.",
          );
        }

        if (
          !Array.isArray(pageEssentialResources) ||
          pageEssentialResources.length !== validatedPageEntries.length
        ) {
          throw new Error(
            "Lynx output must declare resources for every page entry.",
          );
        }
        const validatedPageEssentialResources = pageEssentialResources.map(
          (descriptor, descriptorIndex) => {
            if (
              !descriptor ||
              typeof descriptor !== "object" ||
              Array.isArray(descriptor) ||
              Object.keys(descriptor).sort().join(",") !== "entry,resources"
            ) {
              throw new Error(
                "Lynx page resource descriptors must contain only entry and resources.",
              );
            }
            const descriptorEntry = assertPortablePath(
              descriptor.entry,
              "Lynx page resource entry",
            );
            if (descriptorEntry !== validatedPageEntries[descriptorIndex]) {
              throw new Error(
                "Lynx page resource descriptors must match page entry order.",
              );
            }
            if (
              !Array.isArray(descriptor.resources) ||
              descriptor.resources.length === 0
            ) {
              throw new Error(
                `Lynx page resources must be non-empty: ${descriptorEntry}`,
              );
            }
            const resources = descriptor.resources.map((resource: unknown) =>
              assertPortablePath(resource, "Lynx page resource"),
            );
            assertCanonicalOrder(resources, "Lynx page resources");
            if (findPortableArtifactPathConflict(resources)) {
              throw new Error(
                `Lynx page resources must be collision-free: ${descriptorEntry}`,
              );
            }
            if (!resources.includes(descriptorEntry)) {
              throw new Error(
                `Lynx page resources must include their page entry: ${descriptorEntry}`,
              );
            }
            for (const resource of resources) {
              const stat = artifactStats.get(resource);
              if (!stat || stat.size === 0) {
                throw new Error(
                  `Lynx page resource must be a non-empty output file: ${resource}`,
                );
              }
            }
            return { entry: descriptorEntry, resources };
          },
        );

        const entryStat = artifactStats.get(entry);
        if (!entryStat || entryStat.size === 0) {
          throw new Error("Lynx entry must be a non-empty file.");
        }
        const sidecar = `${JSON.stringify(
          {
            schemaVersion: 1,
            bundleId,
            platform,
            entry,
            pageEntries: validatedPageEntries,
            pageEssentialResources: validatedPageEssentialResources,
            runtimeId,
          },
          null,
          2,
        )}\n`;
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
        artifactNames.push("hot-updater-lynx.json");
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

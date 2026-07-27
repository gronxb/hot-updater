import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PackageMetadata = Readonly<{
  name: string;
}>;

export type PackedConsumer = Readonly<{
  directory: string;
  dispose: () => Promise<void>;
  packageDirectories: ReadonlyMap<string, string>;
}>;

export const resolveServerPluginPackageDirectories = (
  workspaceRoot: string,
): readonly string[] =>
  [
    "packages/core",
    "plugins/js",
    "packages/bsdiff",
    "plugins/plugin-core",
    "packages/server",
    "packages/analytics",
    "packages/better-auth",
    "plugins/standalone",
  ].map((directory) => path.join(workspaceRoot, directory));

export const resolveStorageV2PackageDirectories = (
  workspaceRoot: string,
): readonly string[] =>
  [
    "packages/core",
    "packages/bsdiff",
    "packages/analytics",
    "packages/better-auth",
    "packages/cli-tools",
    "packages/server",
    "packages/test-utils",
    "plugins/js",
    "plugins/plugin-core",
    "plugins/mock",
    "plugins/aws",
    "plugins/cloudflare",
    "plugins/firebase",
    "plugins/supabase",
    "plugins/standalone",
  ].map((directory) => path.join(workspaceRoot, directory));

const readPackageMetadata = async (
  packageDirectory: string,
): Promise<PackageMetadata> => {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError(`Invalid package metadata in ${packageDirectory}`);
  }
  const name = Reflect.get(parsed, "name");
  if (typeof name !== "string") {
    throw new TypeError(`Missing package name in ${packageDirectory}`);
  }
  return { name };
};

const packPackage = async (
  sourceDirectory: string,
  temporaryDirectory: string,
): Promise<Readonly<{ archive: string; metadata: PackageMetadata }>> => {
  const packDirectory = path.join(
    temporaryDirectory,
    "packs",
    path.basename(sourceDirectory),
  );
  await mkdir(packDirectory, { recursive: true });
  await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: sourceDirectory,
  });
  const archive = (await readdir(packDirectory)).find((entry) =>
    entry.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new Error(`pnpm pack produced no archive for ${sourceDirectory}`);
  }
  return {
    archive: path.join(packDirectory, archive),
    metadata: await readPackageMetadata(sourceDirectory),
  };
};

export const createPackedConsumer = async (
  sourceDirectories: readonly string[],
  additionalDependencies: Readonly<Record<string, string>> = {},
): Promise<PackedConsumer> => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-server-plugins-pack-"),
  );
  try {
    const packedPackages = await Promise.all(
      sourceDirectories.map((sourceDirectory) =>
        packPackage(sourceDirectory, temporaryDirectory),
      ),
    );
    const archiveByName = new Map(
      packedPackages.map(({ archive, metadata }) => [metadata.name, archive]),
    );
    const directory = path.join(temporaryDirectory, "consumer");
    await mkdir(directory);
    const tarballDependencies = Object.fromEntries(
      [...archiveByName].map(([name, archive]) => [name, `file:${archive}`]),
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify(
        {
          private: true,
          dependencies: {
            ...additionalDependencies,
            ...tarballDependencies,
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(directory, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "."',
        "overrides:",
        ...Object.entries(tarballDependencies).map(
          ([name, archive]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(archive)}`,
        ),
        "",
      ].join("\n"),
    );
    await execFileAsync(
      "pnpm",
      [
        "install",
        "--ignore-scripts",
        "--lockfile=false",
        "--prefer-offline",
        "--strict-peer-dependencies=false",
      ],
      { cwd: directory },
    );
    const packedByName = new Map(
      [...archiveByName].map(([name]) => [
        name,
        path.join(directory, "node_modules", name),
      ]),
    );
    await Promise.all(
      [...packedByName.values()].map((target) => access(target)),
    );
    return {
      directory,
      dispose: () => rm(temporaryDirectory, { force: true, recursive: true }),
      packageDirectories: packedByName,
    };
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw error;
  }
};

export const runNode = (
  consumerDirectory: string,
  source: string,
  module: boolean,
) =>
  execFileAsync(
    process.execPath,
    [...(module ? ["--input-type=module"] : []), "--eval", source],
    { cwd: consumerDirectory },
  );

export const runNodeWithConditions = (
  consumerDirectory: string,
  source: string,
  conditions: readonly string[],
) =>
  execFileAsync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
      "--input-type=module",
      "--eval",
      source,
    ],
    { cwd: consumerDirectory },
  );

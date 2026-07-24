import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PackageMetadata = Readonly<{
  dependencies: readonly string[];
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
  const dependencies = Reflect.get(parsed, "dependencies");
  if (typeof name !== "string") {
    throw new TypeError(`Missing package name in ${packageDirectory}`);
  }
  return {
    dependencies:
      typeof dependencies === "object" && dependencies !== null
        ? Object.keys(dependencies)
        : [],
    name,
  };
};

const linkModule = async (
  nodeModulesDirectory: string,
  name: string,
  target: string,
): Promise<void> => {
  const destination = path.join(nodeModulesDirectory, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(target, destination, "dir");
};

const packPackage = async (
  sourceDirectory: string,
  temporaryDirectory: string,
): Promise<Readonly<{ directory: string; metadata: PackageMetadata }>> => {
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
  const extractDirectory = path.join(packDirectory, "extracted");
  await mkdir(extractDirectory);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packDirectory, archive), "-C", extractDirectory],
    { cwd: sourceDirectory },
  );
  const directory = path.join(extractDirectory, "package");
  return {
    directory,
    metadata: await readPackageMetadata(directory),
  };
};

export const createPackedConsumer = async (
  sourceDirectories: readonly string[],
): Promise<PackedConsumer> => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-server-plugins-pack-"),
  );
  const packedPackages = await Promise.all(
    sourceDirectories.map((sourceDirectory) =>
      packPackage(sourceDirectory, temporaryDirectory),
    ),
  );
  const packedByName = new Map(
    packedPackages.map(({ directory, metadata }) => [metadata.name, directory]),
  );
  const sourceByName = new Map(
    await Promise.all(
      sourceDirectories.map(
        async (directory) =>
          [(await readPackageMetadata(directory)).name, directory] as const,
      ),
    ),
  );

  for (const { directory, metadata } of packedPackages) {
    const nodeModulesDirectory = path.join(directory, "node_modules");
    await mkdir(nodeModulesDirectory);
    for (const dependency of metadata.dependencies) {
      const packedDependency = packedByName.get(dependency);
      const target =
        packedDependency ??
        path.join(
          sourceByName.get(metadata.name) ?? "",
          "node_modules",
          dependency,
        );
      await access(target);
      await linkModule(nodeModulesDirectory, dependency, target);
    }
  }

  const directory = path.join(temporaryDirectory, "consumer");
  const nodeModulesDirectory = path.join(directory, "node_modules");
  await mkdir(nodeModulesDirectory, { recursive: true });
  for (const [name, packageDirectory] of packedByName) {
    await linkModule(nodeModulesDirectory, name, packageDirectory);
  }
  return {
    directory,
    dispose: () => rm(temporaryDirectory, { force: true, recursive: true }),
    packageDirectories: packedByName,
  };
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

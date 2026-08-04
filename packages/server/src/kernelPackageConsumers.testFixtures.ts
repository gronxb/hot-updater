import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const serverDirectory = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(serverDirectory, "../..");
const packageSources = {
  pluginCore: path.join(workspaceRoot, "plugins", "plugin-core"),
  server: serverDirectory,
} as const;

export type PackedPackageName = keyof typeof packageSources;

const packedPackageDirectories: Partial<Record<PackedPackageName, string>> = {};
let temporaryDirectory: string | undefined;

const getPackedPackageDirectory = (name: PackedPackageName): string => {
  const directory = packedPackageDirectories[name];
  if (directory === undefined) {
    throw new TypeError(`Packed ${name} package is not ready.`);
  }
  return directory;
};

const packPackage = async (name: PackedPackageName): Promise<void> => {
  if (temporaryDirectory === undefined) {
    throw new TypeError("Temporary package directory is not ready.");
  }

  const sourceDirectory = packageSources[name];
  const packDirectory = path.join(temporaryDirectory, `${name}-pack`);
  await mkdir(packDirectory);
  await execFileAsync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: sourceDirectory,
  });

  const archive = (await readdir(packDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError(`pnpm pack did not create an archive for ${name}.`);
  }

  const installDirectory = path.join(temporaryDirectory, `${name}-installed`);
  await mkdir(installDirectory);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(packDirectory, archive), "-C", installDirectory],
    { cwd: workspaceRoot },
  );

  const packageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(sourceDirectory, "node_modules"),
    path.join(packageDirectory, "node_modules"),
    "dir",
  );
  packedPackageDirectories[name] = packageDirectory;
};

export const preparePackedKernelPackages = async (): Promise<void> => {
  temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-kernel-packages-"),
  );
  await Promise.all([packPackage("pluginCore"), packPackage("server")]);
  await access(
    path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc6"),
  );
};

export const cleanupPackedKernelPackages = async (): Promise<void> => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

export const runPackedNode = (
  name: PackedPackageName,
  source: string,
  asModule = false,
) =>
  execFileAsync(
    process.execPath,
    [...(asModule ? ["--input-type=module"] : []), "--eval", source],
    { cwd: getPackedPackageDirectory(name) },
  );

export const typeCheckPackedConsumer = async (
  name: PackedPackageName,
  file: `${string}.mts` | `${string}.cts`,
  source: string,
): Promise<void> => {
  const consumer = path.join(getPackedPackageDirectory(name), file);
  await writeFile(consumer, source);
  await execFileAsync(
    process.execPath,
    [
      path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc6"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      consumer,
    ],
    { cwd: getPackedPackageDirectory(name) },
  );
};

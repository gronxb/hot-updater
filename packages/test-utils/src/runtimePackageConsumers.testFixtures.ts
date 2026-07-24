import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);
export const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

const temporaryDirectories: string[] = [];

interface PackedPackage {
  readonly packageDirectory: string;
}

export const packProvider = async (
  providerDirectory: string,
): Promise<PackedPackage> => {
  const sourceDirectory = path.join(
    workspaceRoot,
    "plugins",
    providerDirectory,
  );
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), `hot-updater-${providerDirectory}-pack-`),
  );
  temporaryDirectories.push(temporaryDirectory);

  await execFileAsync(
    "pnpm",
    ["pack", "--pack-destination", temporaryDirectory],
    { cwd: sourceDirectory },
  );

  const archive = (await readdir(temporaryDirectory)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (!archive) {
    throw new Error(
      `pnpm pack did not create an archive for ${providerDirectory}`,
    );
  }

  const installDirectory = path.join(temporaryDirectory, "installed");
  await mkdir(installDirectory);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(temporaryDirectory, archive), "-C", installDirectory],
    { cwd: workspaceRoot },
  );

  const packageDirectory = path.join(installDirectory, "package");
  await symlink(
    path.join(sourceDirectory, "node_modules"),
    path.join(packageDirectory, "node_modules"),
    "dir",
  );

  return { packageDirectory };
};

export const runNode = (
  packageDirectory: string,
  source: string,
  asModule = false,
) =>
  execFileAsync(
    process.execPath,
    [...(asModule ? ["--input-type=module"] : []), "--eval", source],
    { cwd: packageDirectory },
  );

export const readCommandOutput = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const stdout = "stdout" in error ? error.stdout : undefined;
  const stderr = "stderr" in error ? error.stderr : undefined;
  return [stdout, stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
};

export const cleanupPackedPackages = async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
};

import fs from "node:fs";
import path from "node:path";

import { getCwd } from "./cwd.js";

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
] as const;

const packageManagerField = (dir: string): string | undefined => {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
    );
  } catch {
    return undefined;
  }
  const field =
    typeof packageJson === "object" && packageJson !== null
      ? Reflect.get(packageJson, "packageManager")
      : undefined;
  return typeof field === "string"
    ? field.split("@")[0] || undefined
    : undefined;
};

const userAgentPackageManager = (): string | undefined => {
  const [packageManagerWithVersion] =
    process.env["npm_config_user_agent"]?.split(" ") ?? [];
  return packageManagerWithVersion?.split("/")[0] || undefined;
};

/**
 * The package manager of the project at `cwd`: the nearest `packageManager`
 * field or lockfile, up to the workspace root, else the one that ran the
 * CLI, else npm. The project's comes first: `npx hot-updater` in a pnpm
 * workspace runs under npm, which can't install `workspace:` dependencies.
 */
export const getPackageManager = (cwd: string = getCwd()): string => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const field = packageManagerField(dir);
    if (field) return field;
    const lockfile = LOCKFILES.find(([file]) =>
      fs.existsSync(path.join(dir, file)),
    );
    if (lockfile) return lockfile[1];
    if (path.dirname(dir) === dir) break;
  }
  return userAgentPackageManager() ?? "npm";
};

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { currentE2eTarget, REPOSITORY_ROOT } from "./targets.ts";

/**
 * The app of the E2E target this process runs (`HOT_UPDATER_E2E_TARGET`). e2e
 * is no workspace package, so it reaches Hot Updater's packages as the app
 * installs them: the app's own dependencies, and the packages `hot-updater`
 * and `@hot-updater/server` depend on.
 */
const appPackageJson = (appDir?: string) =>
  path.join(
    appDir ?? path.join(REPOSITORY_ROOT, currentE2eTarget().appDir),
    "package.json",
  );

type Exports = Record<string, unknown>;

/** The directory of `name` for the app: its own dependency, or one of the CLI's or the server's. */
const packageDir = (name: string, appDir?: string): string => {
  const appPackage = appPackageJson(appDir);
  const app = createRequire(appPackage);
  const parents = [
    appPackage,
    app.resolve("hot-updater/package.json"),
    app.resolve("@hot-updater/server/package.json"),
  ];
  for (const parent of parents) {
    try {
      return path.dirname(
        createRequire(parent).resolve(`${name}/package.json`),
      );
    } catch {
      // Not among this one's dependencies.
    }
  }
  throw new Error(`${name} is not among the example app's dependencies.`);
};

/** The ESM file an export condition names. */
const importTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const conditions = entry as Record<string, unknown>;
  return importTarget(conditions["import"] ?? conditions["default"]);
};

/**
 * Imports one of a package's published entries, such as
 * `@hot-updater/server/plugins`, from what the example app
 * installs. A subpath the package does not export is refused, as Node
 * refuses it for the app.
 */
export const importPublished = async <T = Exports>(
  specifier: string,
): Promise<T> => {
  const match = /^(@[^/]+\/[^/]+|[^@][^/]*)(\/.*)?$/.exec(specifier);
  if (!match) throw new Error(`${specifier} names no package.`);
  const [, name, rest] = match as unknown as [string, string, string?];
  const dir = packageDir(name);
  const { exports } = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { readonly exports?: Record<string, unknown> };
  const target = importTarget(exports?.[rest ? `.${rest}` : "."]);
  if (target === undefined) {
    throw new Error(`${name} does not export ${rest ? `.${rest}` : "."}.`);
  }
  return (await import(pathToFileURL(path.join(dir, target)).href)) as T;
};

/**
 * The file a package's `bin` names, from what the example app installs: the
 * command `npx <command>` runs in the app. `appDir` defaults to the app of
 * this process's target.
 */
export const publishedBin = (
  name: string,
  command = name,
  appDir?: string,
): string => {
  const dir = packageDir(name, appDir);
  const { bin } = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { readonly bin?: string | Readonly<Record<string, string>> };
  const target = typeof bin === "string" ? bin : bin?.[command];
  if (target === undefined) {
    throw new Error(`${name} has no ${command} command.`);
  }
  return path.join(dir, target);
};

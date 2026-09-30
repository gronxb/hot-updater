import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { build, type Plugin } from "esbuild";

export interface BundleServerOptions {
  /** The entry module, inside the project so its imports resolve there. */
  readonly input: string;
  readonly outfile: string;
  readonly format: "esm" | "cjs";
  /** `neutral` for runtimes that are not Node, such as Deno. */
  readonly platform: "node" | "neutral";
  /** Modules the runtime provides, left as imports; `*` matches any subpath. */
  readonly external?: readonly string[];
  /** Export conditions for `neutral`, most specific first. */
  readonly conditions?: readonly string[];
  /**
   * Imports to replace, matched exactly: an absolute path is bundled from
   * that file, and a bare specifier stays an import under that name.
   */
  readonly alias?: Readonly<Record<string, string>>;
  /** Expressions to replace with values, such as a deploy's bucket name. */
  readonly define?: Readonly<Record<string, string>>;
  /** Code placed before the bundle, such as a global the runtime lacks. */
  readonly banner?: string;
  /** Where the server runs, for messages, such as "the AWS Lambda@Edge function". */
  readonly target: string;
}

export interface BundledServer {
  /** The size of `outfile`. */
  readonly bytes: number;
}

// esbuild runs filters as Go regular expressions, which take no flags.
const BUILTIN = new RegExp(
  `^(node:)?(${builtinModules
    .map((name) => name.replace(/^node:/, "").replaceAll("/", "\\/"))
    .join("|")})(\\/.*)?$`,
);

/** Node's built-in modules, left as `node:` imports, which Deno resolves. */
const nodeBuiltins: Plugin = {
  name: "hot-updater:node-builtins",
  setup(builder) {
    builder.onResolve({ filter: BUILTIN }, ({ path: id }) => ({
      path: id.startsWith("node:") ? id : `node:${id}`,
      external: true,
    }));
  },
};

/** Replaces exact imports, unlike esbuild's `alias`, which also rewrites subpaths. */
const exactAlias = (alias: Readonly<Record<string, string>>): Plugin => ({
  name: "hot-updater:alias",
  setup(builder) {
    const names = Object.keys(alias);
    if (names.length === 0) return;
    const filter = new RegExp(
      `^(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`,
    );
    builder.onResolve({ filter }, ({ path: id }) => {
      const target = alias[id]!;
      return path.isAbsolute(target)
        ? { path: target }
        : { path: target, external: true };
    });
  },
});

/** The directory of the package.json that names `directory`'s package. */
const packageRootOf = async (
  directory: string,
  roots: Map<string, string | null>,
): Promise<string | null> => {
  if (roots.has(directory)) return roots.get(directory)!;
  const manifest = await fs
    .readFile(path.join(directory, "package.json"), "utf-8")
    .then((text) => JSON.parse(text) as { name?: unknown })
    .catch(() => null);
  const parent = path.dirname(directory);
  const root =
    manifest !== null && typeof manifest.name === "string"
      ? directory
      : parent === directory
        ? null
        : await packageRootOf(parent, roots);
  roots.set(directory, root);
  return root;
};

/**
 * Two copies of the server in one bundle would split its classes, so an
 * error one throws would fail the other's `instanceof` checks.
 */
const assertOneServer = async (files: readonly string[]) => {
  const roots = new Map<string, string | null>();
  const servers = new Map<string, string>();
  for (const file of files) {
    const root = await packageRootOf(path.dirname(file), roots);
    if (root === null || servers.has(root)) continue;
    const { name, version } = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf-8"),
    ) as { name?: string; version?: string };
    if (name === "@hot-updater/server") servers.set(root, version ?? "?");
  }
  if (servers.size > 1) {
    const found = [...servers]
      .map(([root, version]) => `${version} (${root})`)
      .join(" and ");
    throw new Error(
      `it would include two copies of @hot-updater/server: ${found}. Install the version your provider package uses, so the plugins run on the same server.`,
    );
  }
};

/**
 * Bundles a managed server with the project's plugins into one file. The
 * entry's imports resolve from the project, so the plugins' dependencies
 * come in too; only `external` and Node's built-ins stay imports.
 */
export const bundleServer = async ({
  input,
  outfile,
  format,
  platform,
  external = [],
  conditions,
  alias = {},
  define,
  banner,
  target,
}: BundleServerOptions): Promise<BundledServer> => {
  const workingDirectory = path.dirname(input);
  try {
    const { metafile } = await build({
      absWorkingDir: workingDirectory,
      entryPoints: [input],
      outfile,
      bundle: true,
      format,
      platform,
      target: "es2022",
      external: [...external],
      plugins: [
        exactAlias(alias),
        ...(platform === "neutral" ? [nodeBuiltins] : []),
      ],
      ...(platform === "neutral"
        ? {
            mainFields: ["module", "main"],
            conditions: [...(conditions ?? [])],
          }
        : {}),
      ...(define === undefined ? {} : { define: { ...define } }),
      ...(banner === undefined ? {} : { banner: { js: banner } }),
      metafile: true,
      logLevel: "silent",
    });
    await assertOneServer(
      Object.keys(metafile.inputs)
        .filter((file) => !file.includes(":"))
        .map((file) => path.resolve(workingDirectory, file)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not build ${target} with ${input}: ${message}`, {
      cause: error,
    });
  }
  return { bytes: (await fs.stat(outfile)).size };
};

import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { build, type Plugin } from "esbuild";

import { InitError } from "./initOptions";

export interface BundleServerOptions {
  /** The entry module, which imports the server definition. */
  readonly input: string;
  /** The server definition the entry imports, named in messages. */
  readonly definition: string;
  /**
   * The project's directory: paths in the bundle and in its messages are
   * relative to it, so none of the machine's paths are deployed.
   */
  readonly projectRoot?: string;
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

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Built-ins that also answer without `node:`, such as `fs`. */
const unprefixedBuiltins = builtinModules.filter(
  (name) => !name.startsWith("node:"),
);
/** Built-ins only with `node:`, such as `node:sqlite`: bare `sqlite` is an npm package. */
const prefixedBuiltins = builtinModules
  .filter((name) => name.startsWith("node:"))
  .map((name) => name.slice("node:".length));

// esbuild runs filters as Go regular expressions, which take no flags.
const BUILTIN = new RegExp(
  `^(?:node:(?:${[...unprefixedBuiltins, ...prefixedBuiltins]
    .map(escapeRegExp)
    .join("|")})|(?:${unprefixedBuiltins
    .map(escapeRegExp)
    .join("|")}))(?:\\/.*)?$`,
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

/** A refusal that already says what to do. */
class BundleRefusal extends Error {}

/**
 * Two copies of the server in one bundle would split its classes, so an
 * error one throws would fail the other's `instanceof` checks.
 */
const assertOneServer = async (
  files: readonly string[],
  projectRoot: string,
) => {
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
      .map(
        ([root, version]) =>
          `${version} (${path.relative(projectRoot, root) || "."})`,
      )
      .join(" and ");
    throw new BundleRefusal(
      `it would include two copies of @hot-updater/server: ${found}. Install the version your provider package uses, so the plugins run on the same server.`,
    );
  }
};

/**
 * A module scope `require` for a runtime that is not Node, so a CommonJS
 * dependency can require a built-in such as `node:crypto`: esbuild's shim
 * uses it. workerd leaves `import.meta.url` undefined.
 */
const MODULE_REQUIRE = [
  'import { createRequire as __hotUpdaterCreateRequire } from "node:module";',
  'const require = __hotUpdaterCreateRequire(import.meta.url ?? "file:///server.js");',
].join("\n");

/**
 * Bundles a managed server with the project's plugins into one file. The
 * entry's imports resolve from the project, so the plugins' dependencies
 * come in too; only `external` and Node's built-ins stay imports.
 */
export const bundleServer = async ({
  input,
  definition,
  projectRoot = process.cwd(),
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
  // esbuild reports real paths, such as macOS's /private/var for /var.
  const workingDirectory = await fs.realpath(projectRoot);
  const shown =
    path.relative(
      workingDirectory,
      await fs.realpath(definition).catch(() => definition),
    ) || definition;
  const preamble = [
    ...(platform === "neutral" && format === "esm" ? [MODULE_REQUIRE] : []),
    ...(banner === undefined ? [] : [banner]),
  ].join("\n");
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
      ...(preamble === "" ? {} : { banner: { js: preamble } }),
      metafile: true,
      logLevel: "silent",
    });
    await assertOneServer(
      Object.keys(metafile.inputs)
        .filter((file) => !file.includes(":"))
        .map((file) => path.resolve(workingDirectory, file)),
      workingDirectory,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InitError(
      `Could not bundle ${shown} into ${target}: ${message}${
        error instanceof BundleRefusal
          ? ""
          : " Fix the server definition, or host the server yourself."
      }`,
      { cause: error },
    );
  }
  return { bytes: (await fs.stat(outfile)).size };
};

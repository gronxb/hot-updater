// @ts-check
/**
 * Checks the package boundaries CLAUDE.md states, from each published
 * package's package.json and the sources of packages/* and plugins/*:
 *
 * - @hot-updater/server exports its root, the built-in adapters and the
 *   built-in plugins, and nothing else;
 * - no package has an export whose key names `internal`, `test` or
 *   `testing`, and no package but @hot-updater/test-utils publishes a spec,
 *   a test fixture or a test helper;
 * - @hot-updater/protocol has no dependencies;
 * - @hot-updater/react-native exports only its root, and neither it nor the
 *   packages its dependencies pull in depend on @hot-updater/plugin-core or
 *   @hot-updater/server;
 * - @hot-updater/test-utils is only ever a devDependency;
 * - every import of a @hot-updater/* package names one of its exports, and
 *   no relative import reaches into another package;
 * - no package has an export only @hot-updater/test-utils imports.
 *
 *   node scripts/ci/check-package-boundaries.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Server's exports. PR 2 of the subpath boundary removes `./db`, `./diff`
 * and `./internal`, which tooling still reads.
 */
const SERVER_EXPORTS = [
  ".",
  "./adapters/drizzle",
  "./adapters/kysely",
  "./adapters/mongodb",
  "./adapters/prisma",
  "./db",
  "./diff",
  "./internal",
  "./plugins/api-keys",
  "./plugins/insights",
  "./package.json",
];
/** Exports a package keeps until the PR that removes them. */
const PENDING_INTERNAL = new Set(["@hot-updater/server ./internal"]);

const TEST_UTILS = "@hot-updater/test-utils";

/**
 * @typedef {{
 *   name: string;
 *   dir: string;
 *   json: Record<string, any>;
 *   published: boolean;
 * }} Package
 */

/** @type {Package[]} */
const packages = ["packages", "plugins"].flatMap((top) =>
  readdirSync(path.join(root, top)).flatMap((entry) => {
    const dir = path.join(root, top, entry);
    const file = path.join(dir, "package.json");
    if (!existsSync(file)) return [];
    const json = JSON.parse(readFileSync(file, "utf8"));
    return [{ name: json.name, dir, json, published: json.private !== true }];
  }),
);
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const published = packages.filter((pkg) => pkg.published);

/** @type {string[]} */
const failures = [];
/** @param {string} rule @param {string} message */
const fail = (rule, message) => failures.push(`[${rule}] ${message}`);

/** @param {Package} pkg */
const exportKeys = (pkg) =>
  typeof pkg.json.exports === "object" && pkg.json.exports !== null
    ? Object.keys(pkg.json.exports)
    : [];

/** @param {Record<string, string> | undefined} deps */
const namesOf = (deps) => Object.keys(deps ?? {});

// Server exports exactly its root, built-in adapters, and built-in plugins.
const server = byName.get("@hot-updater/server");
if (server) {
  const keys = exportKeys(server).sort();
  const expected = [...SERVER_EXPORTS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail(
      "server-exports",
      `@hot-updater/server exports ${keys.join(", ")}; it may export only ${expected.join(", ")}.`,
    );
  }
}

// No internal or test exports.
for (const pkg of published) {
  for (const key of exportKeys(pkg)) {
    if (/internal/i.test(key) && !PENDING_INTERNAL.has(`${pkg.name} ${key}`)) {
      fail(
        "no-internal-exports",
        `${pkg.name} exports ${key}; another package uses only its public exports, and whatever else stays private to the package.`,
      );
    }
    if (pkg.name !== TEST_UTILS && /(^|\/)test(ing|s)?(\/|$)/i.test(key)) {
      fail(
        "tests-in-test-utils",
        `${pkg.name} exports ${key}; test code belongs in ${TEST_UTILS}.`,
      );
    }
  }
}

// Protocol stands alone.
const protocol = byName.get("@hot-updater/protocol");
if (protocol) {
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const names = namesOf(protocol.json[field]);
    if (names.length > 0) {
      fail(
        "protocol-standalone",
        `@hot-updater/protocol has ${field} ${names.join(", ")}; it has none, so it runs anywhere.`,
      );
    }
  }
}

// React Native: its root only, and no server code through its dependencies.
const reactNative = byName.get("@hot-updater/react-native");
if (reactNative) {
  const keys = exportKeys(reactNative).filter((key) => key !== "./package.json");
  if (keys.length !== 1 || keys[0] !== ".") {
    fail(
      "react-native-root",
      `@hot-updater/react-native exports ${keys.join(", ")}; an app imports everything from its root.`,
    );
  }
  /** @type {Map<string, string[]>} */
  const seen = new Map([[reactNative.name, [reactNative.name]]]);
  const queue = [reactNative];
  while (queue.length > 0) {
    const pkg = /** @type {Package} */ (queue.shift());
    for (const dep of namesOf(pkg.json.dependencies)) {
      const next = byName.get(dep);
      if (!next || seen.has(dep)) continue;
      const chain = [...(seen.get(pkg.name) ?? []), dep];
      seen.set(dep, chain);
      if (dep === "@hot-updater/plugin-core" || dep === "@hot-updater/server") {
        fail(
          "react-native-closure",
          `@hot-updater/react-native pulls in ${dep} through its dependencies (${chain.join(" -> ")}); the app never runs server code.`,
        );
        continue;
      }
      queue.push(next);
    }
  }
}

// Test utilities are a development dependency only.
for (const pkg of published) {
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (namesOf(pkg.json[field]).includes(TEST_UTILS)) {
      fail(
        "test-utils-dev-only",
        `${pkg.name} lists ${TEST_UTILS} in ${field}; a package's own specs use it as a devDependency.`,
      );
    }
  }
}

/** A `files` pattern as a regular expression over a package-relative path. */
const patternOf = (/** @type {string} */ glob) => {
  const source = glob
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  // A pattern names the path itself, or a directory holding it.
  return new RegExp(`^${source}(?:/.*)?$`);
};

/** @param {string} dir @param {string} base @returns {string[]} */
const walk = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? walk(full, base)
      : [path.relative(base, full).split(path.sep).join("/")];
  });

/** Specs, fixtures, and test helpers, by the names this repository gives them. */
const TEST_FILE =
  /(^|\/)(__tests__|__fixtures__|__mocks__)\/|\.(spec|test)\.[cm]?[jt]sx?$|[.-]?test-?([Ff]ixtures?|[Uu]tils?)\.[cm]?[jt]sx?$|\.integration-fixture\.[cm]?[jt]s$|(^|\/)test[A-Z]\w*\.[cm]?[jt]sx?$/;

// What a package publishes holds no specs, fixtures or test helpers.
for (const pkg of published) {
  const files = pkg.json.files;
  if (!Array.isArray(files) || pkg.name === TEST_UTILS) continue;
  const include = files.filter((f) => !f.startsWith("!")).map(patternOf);
  const exclude = files
    .filter((f) => f.startsWith("!"))
    .map((f) => patternOf(f.slice(1)));
  const shipped = walk(pkg.dir).filter(
    (file) =>
      include.some((re) => re.test(file)) &&
      !exclude.some((re) => re.test(file)),
  );
  const tests = shipped.filter((file) => TEST_FILE.test(file));
  if (tests.length > 0) {
    fail(
      "tests-in-test-utils",
      `${pkg.name} publishes ${tests.slice(0, 3).join(", ")}${tests.length > 3 ? ` and ${tests.length - 3} more` : ""}; its files leave out specs, fixtures and test helpers, which belong in ${TEST_UTILS}.`,
    );
  }
}

/** Whether `subpath` is one of the package's exports, patterns included. */
const exports = (/** @type {Package} */ pkg, /** @type {string} */ subpath) =>
  exportKeys(pkg).some((key) =>
    key.includes("*")
      ? new RegExp(
          `^${key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("\\*", ".*")}$`,
        ).test(subpath)
      : key === subpath,
  ) ||
  (subpath === "." && exportKeys(pkg).length === 0 && "main" in pkg.json);

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = new Set(["node_modules", "dist", "build", ".nx", ".output", ".turbo"]);
/** @param {string} dir @returns {string[]} */
const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [full]
      : [];
  });

/** The package whose directory holds `file`. */
const ownerOf = (/** @type {string} */ file) =>
  packages.find(
    (pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}${path.sep}`),
  );

/** Importers of each package export, by `name subpath`. */
/** @type {Map<string, Set<string>>} */
const importers = new Map();

// Imports name published exports, and stay inside their own package.
for (const pkg of packages) {
  for (const file of sources(pkg.dir)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("@hot-updater/") && !text.includes("../")) continue;
    const specifiers = ts
      .preProcessFile(text, true, true)
      .importedFiles.map(({ fileName }) => fileName);
    const at = path.relative(root, file);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const owner = ownerOf(target);
        if (owner && owner !== pkg) {
          fail(
            "public-imports",
            `${at} imports ${specifier}, inside ${owner.name}; import that package's exports by name.`,
          );
        }
        continue;
      }
      const match = /^(@hot-updater\/[^/]+)(\/.*)?$/.exec(specifier);
      if (!match) continue;
      const target = byName.get(/** @type {string} */ (match[1]));
      if (!target) continue;
      const subpath = match[2] ? `.${match[2]}` : ".";
      if (!exports(target, subpath)) {
        fail(
          "public-imports",
          `${at} imports ${specifier}, which ${target.name} does not export; import one of its exports.`,
        );
        continue;
      }
      if (target !== pkg) {
        const key = `${target.name} ${subpath}`;
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key)?.add(pkg.name);
      }
    }
  }
}

// An export exists for its users, not for test-utils alone.
for (const [key, users] of importers) {
  const [name, subpath] = key.split(" ");
  if (name === TEST_UTILS || subpath === "." || subpath === "./package.json") {
    continue;
  }
  if (users.size === 1 && users.has(TEST_UTILS)) {
    fail(
      "no-test-only-exports",
      `${name} exports ${subpath} that only ${TEST_UTILS} imports; give it a reason of its own, or keep the code in ${TEST_UTILS}.`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    [
      `Package boundaries broken (${failures.length}). See "Package boundaries" in CLAUDE.md.`,
      ...failures.map((failure) => `  ${failure}`),
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Package boundaries hold across ${published.length} published packages.`,
  );
}

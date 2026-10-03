// @ts-check
/**
 * Checks the package boundaries CLAUDE.md states, from each workspace
 * package's package.json and sources, and the E2E harness's sources:
 *
 * - @hot-updater/server exports its root, the built-in adapters and the
 *   built-in plugins, and nothing else;
 * - no package has an export whose key names `internal` or test code, and no
 *   package but @hot-updater/test-utils publishes a spec, a test fixture or a
 *   test helper; a published package lists what it publishes in `files`;
 * - @hot-updater/protocol has no dependencies;
 * - @hot-updater/react-native exports its runtime root and Node-only build entry; neither it nor the
 *   packages it pulls in (dependencies, optional dependencies, and peers that
 *   are not optional) depend on @hot-updater/plugin-core or
 *   @hot-updater/server;
 * - @hot-updater/test-utils is only ever a devDependency;
 * - every import of a @hot-updater/* package, `vi.mock` included, names one
 *   of its exports, no relative import reaches into another package, and an
 *   import() or `vi` load whose specifier is computed is one this script
 *   lists; a spec this script lists may reach another package's private
 *   source, for the reason it gives;
 * - no package has an export only @hot-updater/test-utils imports.
 *
 *   node scripts/ci/check-package-boundaries.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Server's exports: its root, the built-in adapters, and the built-in
 * plugins. Tooling reads a server through the definition's public
 * properties, not an entry of its own.
 */
const SERVER_EXPORTS = [
  ".",
  "./adapters/drizzle",
  "./adapters/kysely",
  "./adapters/mongodb",
  "./adapters/prisma",
  "./plugins/api-keys",
  "./plugins/insights",
  "./package.json",
];

/**
 * Sources whose import() computes its specifier: each loads a file by path,
 * which no import of a package names, and a new one needs a deliberate entry.
 */
const COMPUTED_IMPORTS = new Map([
  [
    "e2e/lynx/native-public-key-integrity.spec.ts",
    "loads the unpublished example's native-key attestation helper",
  ],
  [
    "packages/hot-updater/src/commands/init.ts",
    "loads the selected integration package's public /integration descriptor",
  ],
  [
    "packages/hot-updater/src/commands/doctor.spec.ts",
    "loads the CLI command under test after mocking its local dependencies",
  ],
  [
    "packages/lynx/src/exampleBuild.spec.ts",
    "loads build scripts of the unpublished Lynx fixture app",
  ],
  [
    "packages/lynx/src/navigationExample.spec.ts",
    "loads the unpublished Lynx navigation fixture",
  ],
  [
    "packages/lynx/src/packageContract.spec.ts",
    "loads the package export targets from its own dist to check device import safety",
  ],
  [
    "examples/lynx/octane/lynx.config.mjs",
    "loads the pinned local Octane compiler prepared for the example",
  ],
  [
    "examples/lynx/scripts/external-bootstrap.mjs",
    "loads the configured external page fixture",
  ],
  [
    "examples/lynx/spike/compiler-page-resource-loader.cjs",
    "loads the Lynx compiler declared by the fixture project",
  ],
  [
    "e2e/detox/control-server/deploy-asset-guard.spec.ts",
    "loads the generated fixture guard module",
  ],
  [
    "plugins/expo/src/fingerprint.ts",
    "imports the app's resolved @expo/fingerprint public entry",
  ],
  ["e2e/detox/contracts.spec.ts", "loads e2e's own control server"],
  [
    "e2e/detox/published.ts",
    "imports a package's published entry as the example app installs it",
  ],
  [
    "packages/hot-updater/agent/provision-client-credential.mjs",
    "runs the scaffold's migrate.ts",
  ],
  [
    "packages/hot-updater/scripts/build-infra-templates.mjs",
    "reads the provider sources the templates come from",
  ],
  [
    "packages/hot-updater/src/cliDocsLinks.spec.ts",
    "parses the docs content, which no package exports",
  ],
  [
    "packages/hot-updater/src/commands/agent/infra.spec.ts",
    "loads the scaffold it generated",
  ],
  [
    "packages/server/src/adapters/drizzle.spec.ts",
    "loads the schema file it generated",
  ],
]);

/**
 * Specs that import another package's private source, each with the reason
 * no public API serves it. A new one needs a deliberate entry.
 * @type {Map<string, string>}
 */
const PRIVATE_SOURCE_SPECS = new Map([
  [
    "e2e/lynx/native-public-key-integrity.spec.ts",
    "verifies the CLI's private native-key writers against the example source attestation; these parsers are not public SDK APIs",
  ],
]);

const TEST_UTILS = "@hot-updater/test-utils";

/**
 * @typedef {{
 *   name: string;
 *   dir: string;
 *   json: Record<string, any>;
 *   published: boolean;
 * }} Package
 */

/** The workspace's package directories, as pnpm-workspace.yaml lists them. */
const workspaceDirs = () => {
  const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [
    ...(/^packages:\n((?:\s+-\s+.+\n?)+)/m.exec(yaml)?.[1] ?? "").matchAll(
      /-\s+["']?([^"'\n]+)["']?/g,
    ),
  ].map((match) => /** @type {string} */ (match[1]).trim());
  return globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [path.join(root, glob)];
    const parent = path.join(root, glob.slice(0, -2));
    return existsSync(parent)
      ? readdirSync(parent).map((entry) => path.join(parent, entry))
      : [];
  });
};

/** @type {Package[]} */
const packages = workspaceDirs().flatMap((dir) => {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, "utf8"));
  return [{ name: json.name, dir, json, published: json.private !== true }];
});
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

/** Export keys that name test code. */
const TEST_EXPORT = /(^|\/)(tests?|testing|test-utils|fixtures?|mocks?)(\/|$)/i;

// No internal or test exports, in any workspace package.
for (const pkg of packages) {
  for (const key of exportKeys(pkg)) {
    if (/internal/i.test(key)) {
      fail(
        "no-internal-exports",
        `${pkg.name} exports ${key}; another package uses only its public exports, and whatever else stays private to the package.`,
      );
    }
    if (pkg.name !== TEST_UTILS && TEST_EXPORT.test(key)) {
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

/** What installing `pkg` pulls in: dependencies, optional ones, and peers not marked optional. */
const installed = (/** @type {Package} */ pkg) => {
  const optionalPeers = pkg.json.peerDependenciesMeta ?? {};
  return [
    ...namesOf(pkg.json.dependencies),
    ...namesOf(pkg.json.optionalDependencies),
    ...namesOf(pkg.json.peerDependencies).filter(
      (name) => optionalPeers[name]?.optional !== true,
    ),
  ];
};

// Device imports use the root; the explicit build entry stays in Node tooling.
const reactNative = byName.get("@hot-updater/react-native");
if (reactNative) {
  const keys = exportKeys(reactNative).filter(
    (key) => key !== "./package.json",
  );
  if (keys.length !== 2 || !keys.includes(".") || !keys.includes("./build")) {
    fail(
      "react-native-root",
      `@hot-updater/react-native exports ${keys.join(", ")}; only the runtime root and Node-only /build are allowed.`,
    );
  }
  /** @type {Map<string, string[]>} */
  const seen = new Map([[reactNative.name, [reactNative.name]]]);
  const queue = [reactNative];
  while (queue.length > 0) {
    const pkg = /** @type {Package} */ (queue.shift());
    for (const dep of installed(pkg)) {
      const next = byName.get(dep);
      if (!next || seen.has(dep)) continue;
      const chain = [...(seen.get(pkg.name) ?? []), dep];
      seen.set(dep, chain);
      if (dep === "@hot-updater/plugin-core" || dep === "@hot-updater/server") {
        fail(
          "react-native-closure",
          `@hot-updater/react-native pulls in ${dep} (${chain.join(" -> ")}); the app never runs server code.`,
        );
        continue;
      }
      queue.push(next);
    }
  }
}

// Test utilities are a development dependency only, in any workspace package.
for (const pkg of packages) {
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
    if (
      entry.name === "node_modules" ||
      entry.name.startsWith("runtime-acceptance-")
    )
      return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? walk(full, base)
      : [path.relative(base, full).split(path.sep).join("/")];
  });

/** Specs, fixtures, and test helpers, by the names this repository gives them. */
const TEST_FILE = new RegExp(
  [
    String.raw`(^|/)(__tests__|__fixtures__|__mocks__)/`,
    // JUnit sources, such as android/src/test.
    String.raw`(^|/)src/test/`,
    // Xcode test targets.
    String.raw`(^|/)Tests?/`,
    String.raw`\.(spec|test)\.[cm]?[jt]sx?$`,
    String.raw`[.-]?test-?([Ff]ixtures?|[Uu]tils?)\.[cm]?[jt]sx?$`,
    String.raw`\.integration-fixture\.[cm]?[jt]s$`,
    String.raw`(^|/)(test|\w+Test)[A-Z]\w*\.[cm]?[jt]sx?$`,
  ].join("|"),
);

// What a package publishes, which `files` lists, holds no specs, fixtures
// or test helpers.
for (const pkg of published) {
  if (pkg.name === TEST_UTILS) continue;
  const files = pkg.json.files;
  if (!Array.isArray(files)) {
    fail(
      "tests-in-test-utils",
      `${pkg.name} has no files; list what it publishes, so its specs and test helpers stay out.`,
    );
    continue;
  }
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

/** Escapes `text` for a regular expression. */
const escape = (/** @type {string} */ text) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `subpath` is one of the package's exports, patterns included. */
const exports = (/** @type {Package} */ pkg, /** @type {string} */ subpath) =>
  exportKeys(pkg).some((key) =>
    key.includes("*")
      ? new RegExp(`^${key.split("*").map(escape).join(".+")}$`).test(subpath)
      : key === subpath,
  ) ||
  (subpath === "." && exportKeys(pkg).length === 0 && "main" in pkg.json);

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "lib",
  "ios",
  "android",
  ".nx",
  ".output",
  ".turbo",
]);
/** @param {string} dir @returns {string[]} */
const sources = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      SKIP.has(entry.name) ||
      entry.name.startsWith(".") ||
      entry.name.startsWith("runtime-acceptance-")
    )
      return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });

/** The package whose directory holds `file`. */
const ownerOf = (/** @type {string} */ file) =>
  packages.find(
    (pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}${path.sep}`),
  );

/** `vi` calls that load a module by its specifier. */
const VI_LOADS = new Set(["mock", "doMock", "importActual", "importMock"]);

/**
 * What a source imports: its static and literal dynamic imports, the modules
 * `vi.mock` and its kin name, and whether an import() computes its specifier.
 */
const importsOf = (/** @type {string} */ file, /** @type {string} */ text) => {
  const specifiers = ts
    .preProcessFile(text, true, true)
    .importedFiles.map(({ fileName }) => fileName);
  let computed = false;
  if (/\bimport\s*\(|\bvi\s*\./.test(text)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    /** @param {ts.Node} node */
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const [first] = node.arguments;
        const literal =
          first !== undefined &&
          (ts.isStringLiteral(first) ||
            ts.isNoSubstitutionTemplateLiteral(first));
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (!literal) computed = true;
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "vi" &&
          VI_LOADS.has(node.expression.name.text)
        ) {
          if (literal) specifiers.push(first.text);
          else computed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { specifiers, computed };
};

// A Node-only build export must never become reachable from a device entry.
// Follow local re-exports too: a package-level optional peer check cannot catch them.
for (const name of ["@hot-updater/react-native", "@hot-updater/lynx"]) {
  const pkg = byName.get(name);
  if (!pkg) continue;
  const pending = [path.join(pkg.dir, "src/index.ts")];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    for (const specifier of importsOf(file, readFileSync(file, "utf8"))
      .specifiers) {
      if (
        specifier.startsWith("node:") ||
        /^@hot-updater\/(?:plugin-core|server)(?:\/|$)/.test(specifier)
      ) {
        fail(
          "device-source-closure",
          `${path.relative(root, file)} reaches ${specifier} from ${name}'s device entry.`,
        );
      }
      if (!specifier.startsWith(".")) continue;
      const target = path
        .resolve(path.dirname(file), specifier)
        .replace(/\.jsx?$/, "");
      const source = [
        target + ".ts",
        target + ".tsx",
        path.join(target, "index.ts"),
        path.join(target, "index.tsx"),
      ].find(existsSync);
      if (source) pending.push(source);
    }
  }
}

/** Importers of each package export, by `name subpath`. */
/** @type {Map<string, Set<string>>} */
const importers = new Map();

/**
 * Sources outside any package that reach the packages as an app does: the
 * E2E harness, which imports their published entries.
 */
const OUTSIDE = [
  { name: "e2e", dir: path.join(root, "e2e"), json: {}, published: false },
];

// Imports name published exports, and stay inside their own package.
for (const pkg of [...packages, ...OUTSIDE]) {
  if (!existsSync(pkg.dir)) continue;
  for (const file of sources(pkg.dir)) {
    const text = readFileSync(file, "utf8");
    if (!/@hot-updater\/|\.\.\/|\bimport\s*\(/.test(text)) continue;
    const at = path.relative(root, file).split(path.sep).join("/");
    const { specifiers, computed } = importsOf(file, text);
    const privateSource = PRIVATE_SOURCE_SPECS.has(at);
    if (computed && !COMPUTED_IMPORTS.has(at) && !privateSource) {
      fail(
        "public-imports",
        `${at} computes an import() specifier, which no check can follow; import a package's exports by name, or list the file in COMPUTED_IMPORTS with what it loads.`,
      );
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const owner = ownerOf(target);
        const lynxFixture =
          owner?.name === "@hot-updater/example-lynx" && pkg.name === "e2e";
        if (owner && owner !== pkg && !privateSource && !lynxFixture) {
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
      if (target !== pkg && !OUTSIDE.includes(pkg)) {
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
    `Package boundaries hold across ${packages.length} workspace packages, ${published.length} of them published.`,
  );
}

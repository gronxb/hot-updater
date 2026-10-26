import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CREDENTIAL_ENV_NAMES, maskSecretValues } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fg from "fast-glob";
import plist from "plist";

import type { NativeBuildArtifactKind } from "./createNativeBuild";

/**
 * What computes a native build key. Change it with any change to what is
 * hashed or how, so every cached build misses once instead of matching a key
 * that means something else.
 */
export const NATIVE_BUILD_KEY_ENGINE = "hot-updater/native-build@1";

/** A native build key: the engine's prefix and a SHA-256. */
export const NATIVE_BUILD_KEY_PATTERN = /^nbk1:[0-9a-f]{64}$/;

/**
 * What a native build key hashes, by component, as meta.json records it so a
 * later key can say what changed. Values are digests, names, and tool
 * versions: never a secret's value.
 */
export interface NativeBuildKeyComponents {
  readonly engine: string;
  /** Every file of the git repository but the CLI's own output: path → git object ID. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Inputs git ignores that the build reads: the native projects' ignored
   * files, `.env*` files, the package manager's install state, and the
   * native packages installed in node_modules. Name → SHA-256.
   */
  readonly inputs: Readonly<Record<string, string>>;
  /** The scheme's settings and what the build embeds. */
  readonly settings: Readonly<Record<string, string>>;
  /** Who signs: certificate and key IDs, never a password or a key. */
  readonly signing: Readonly<Record<string, string>>;
  /** The tools that build, such as Xcode's version or the JDK's. */
  readonly toolchain: Readonly<Record<string, string>>;
  /** Environment variables the build reads: name → SHA-256 of the value. */
  readonly env: Readonly<Record<string, string>>;
}

export type NativeBuildKey =
  | {
      readonly key: string;
      readonly components: NativeBuildKeyComponents;
      readonly uncacheable: null;
    }
  | {
      readonly key: null;
      readonly components: null;
      /** Why no build can be reused, as a sentence. */
      readonly uncacheable: string;
    };

/** The signing identity a build signs with, resolved by the caller. */
export interface NativeBuildKeySigning {
  /** The release keystore of `signing.keystore`. */
  readonly androidKeystore?: {
    readonly storeFile: string;
    readonly storePassword: string;
    readonly keyAlias: string;
  };
  /** The App Store Connect API key of `signing.ascApiKey`. */
  readonly ascApiKey?: { readonly keyId: string; readonly issuerId: string };
}

export interface NativeBuildKeyInput {
  readonly cwd: string;
  readonly platform: Platform;
  /** The `nativeBuild` scheme's name. */
  readonly scheme: string;
  /** The scheme as the build reads it, with its defaults. */
  readonly schemeConfig: Readonly<Record<string, unknown>>;
  readonly artifactKind: NativeBuildArtifactKind;
  readonly channel: string;
  readonly fingerprintHash: string | null;
  readonly appVersion: string | null;
  /** Where the artifact is copied, which the key leaves out. */
  readonly outputPath: string;
  /** The config's `cacheDir`, absolute, or null when caching is off. */
  readonly cacheDir: string | null;
  readonly signing: NativeBuildKeySigning;
  /** The Hot Updater CLI's version. */
  readonly hotUpdaterVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The build tools' versions; tests replace the real probes. */
  readonly readToolchain?: (
    platform: Platform,
    context: ToolchainContext,
  ) => Promise<Record<string, string>>;
}

/** Why a build can't be reused: thrown inside, returned as `uncacheable`. */
class Uncacheable extends Error {}

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const toPosix = (filePath: string) => filePath.split(path.sep).join("/");

/** JSON with object keys sorted, so the order things are read in doesn't count. */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : entry,
  );

/**
 * Directories a build or an editor writes, never an input: a build that
 * writes into node_modules or the native projects leaves the next key as it
 * was.
 */
const GENERATED_SEGMENTS = new Set([
  "node_modules",
  "build",
  "Pods",
  ".gradle",
  ".cxx",
  ".kotlin",
  "DerivedData",
  "xcuserdata",
  ".idea",
  ".hot-updater",
  ".git",
]);

const isGenerated = (relativePath: string) =>
  relativePath.split("/").some((segment) => GENERATED_SEGMENTS.has(segment)) ||
  path.posix.basename(relativePath) === ".DS_Store";

const GENERATED_GLOBS = [
  ...[...GENERATED_SEGMENTS].map((segment) => `**/${segment}/**`),
  "**/.DS_Store",
];

/**
 * Names whose values are credentials: they never enter the key, since a
 * password or a token decides who may publish, not what is built.
 */
const CREDENTIAL_NAME =
  /PASSWORD|PASSWD|STOREPASS|KEYPASS|SECRET|TOKEN|PRIVATE|CREDENTIAL|SERVICE_ROLE|ACCESS_KEY/i;

const HOT_UPDATER_CREDENTIAL_NAMES = new Set<string>(
  Object.values(CREDENTIAL_ENV_NAMES).flatMap((fields) => fields.flat()),
);

const isCredentialName = (name: string) =>
  CREDENTIAL_NAME.test(name) || HOT_UPDATER_CREDENTIAL_NAMES.has(name);

/** Whether `value` holds a secret the CLI resolved, which its logs mask. */
const isSecretValue = (value: string) => maskSecretValues(value) !== value;

/**
 * A value with this machine's directories written relative, so another
 * machine computes the same key: the repository root and the home directory.
 */
const machineIndependent = (value: string, root: string) =>
  value.split(root).join("<root>").split(os.homedir()).join("~");

/** Environment variables the build reads by prefix, whatever the project names. */
const ENV_PREFIXES = [
  "EXPO_PUBLIC_",
  "RCT_",
  "ORG_GRADLE_PROJECT_",
  "HOT_UPDATER_",
];
const ENV_NAMES = ["NODE_ENV", "BABEL_ENV", "ENVFILE"];

/** The shell's own variables, which a script names but no build input sets. */
const SYSTEM_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PWD",
  "OLDPWD",
  "TERM",
  "TERM_PROGRAM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHLVL",
  "_",
]);

/**
 * Reads of environment variables in the files that configure the build, by
 * a name each file spells out, and reads by a computed name, which no key
 * can follow.
 */
const ENV_READS: readonly {
  readonly pattern: RegExp;
  readonly literal: RegExp;
  readonly dynamic: readonly RegExp[];
}[] = [
  {
    // Gradle, in Groovy or Kotlin.
    pattern: /\.gradle(\.kts)?$/,
    literal:
      /(?:System\.getenv|providers\.environmentVariable)\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    dynamic: [
      /System\.getenv\(\s*\)/,
      /System\.getenv\(\s*[^"'\s)]/,
      /providers\.environmentVariable\(\s*[^"'\s)]/,
      /providers\.environmentVariablesPrefixedBy\(/,
    ],
  },
  {
    // CocoaPods' Podfile, in Ruby.
    pattern: /(^|\/)Podfile$/,
    literal: /ENV(?:\[|\.fetch\()\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    dynamic: [
      /ENV\[\s*[^"'\s\]]/,
      /ENV\.fetch\(\s*[^"'\s)]/,
      /ENV\.(?:to_h|to_hash|each|each_pair|select|filter|keys|map)\b/,
    ],
  },
  {
    // Babel, Metro, Expo, and React Native CLI configs.
    pattern:
      /(^|\/)(babel|metro|app|react-native)\.config\.(c|m)?(j|t)s$|(^|\/)\.babelrc(\.js)?$/,
    literal:
      /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g,
    dynamic: [
      /process\.env\[\s*(?!["'][A-Za-z_][A-Za-z0-9_]*["']\s*\])/,
      /\.\.\.\s*process\.env\b(?!\s*[.[])/,
      /\(\s*process\.env\s*\)/,
    ],
  },
  {
    // Xcode build phases, and the environment files they source.
    pattern: /\.pbxproj$|(^|\/)\.xcode\.env(\.local)?$/,
    literal: /\$(?:\{|\()?([A-Z_][A-Z0-9_]*)/g,
    dynamic: [],
  },
];

/** JavaScript the app bundles, whose literal `process.env` reads it inlines. */
const SOURCE_FILE = /\.(c|m)?(j|t)sx?$/;
const SOURCE_ENV_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g;

/**
 * SHA-256s of files, kept across runs by size, modification time, and inode,
 * as git's index keeps object IDs: a file whose modification time is too
 * recent to tell a later write apart is hashed again.
 */
class FileHashes {
  private readonly entries = new Map<
    string,
    { s: number; m: number; i: number; h: string }
  >();
  private readonly used = new Set<string>();
  private readonly loadedAtMs = Date.now();

  private constructor(private readonly file: string | null) {}

  static async open(file: string | null): Promise<FileHashes> {
    const cache = new FileHashes(file);
    if (file !== null) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<
          string,
          { s: number; m: number; i: number; h: string }
        >;
        for (const [key, entry] of Object.entries(parsed)) {
          cache.entries.set(key, entry);
        }
      } catch {
        // No cache yet, or one this version can't read: every file is hashed.
      }
    }
    return cache;
  }

  async hash(absolutePath: string): Promise<string> {
    const stat = await fs.stat(absolutePath);
    this.used.add(absolutePath);
    const cached = this.entries.get(absolutePath);
    if (
      cached &&
      cached.s === stat.size &&
      cached.m === stat.mtimeMs &&
      cached.i === stat.ino &&
      stat.mtimeMs < this.loadedAtMs - 2_000
    ) {
      return cached.h;
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
    }
    const h = hash.digest("hex");
    this.entries.set(absolutePath, {
      s: stat.size,
      m: stat.mtimeMs,
      i: stat.ino,
      h,
    });
    return h;
  }

  /** Writes the files this run hashed, and forgets the rest. */
  async save(): Promise<void> {
    if (this.file === null) return;
    const kept = Object.fromEntries(
      [...this.entries].filter(([key]) => this.used.has(key)),
    );
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(kept));
      await fs.rename(temporary, this.file);
    } catch {
      // A read-only cache directory only makes the next key slower.
    }
  }
}

/** Runs `run` on each item, `limit` at a time. */
const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
};

const git = async (cwd: string, args: string[], input?: string) =>
  (await execa("git", args, { cwd, input, stripFinalNewline: false })).stdout;

const splitNul = (output: string) => output.split("\0").filter(Boolean);

/**
 * Every file of the repository as git sees it, as a commit would record it:
 * the index's object IDs, and the object ID of each modified or untracked
 * file's contents, so staging or touching a file changes nothing.
 */
const readRepositoryFiles = async (
  root: string,
  excluded: (relativePath: string) => boolean,
): Promise<Record<string, string>> => {
  const [staged, changed, deleted, untracked] = await Promise.all([
    git(root, ["ls-files", "-s", "-z"]),
    git(root, ["ls-files", "-m", "-z"]),
    git(root, ["ls-files", "-d", "-z"]),
    git(root, ["ls-files", "-o", "--exclude-standard", "-z"]),
  ]);
  const files: Record<string, string> = {};
  for (const entry of splitNul(staged)) {
    const tab = entry.indexOf("\t");
    const filePath = entry.slice(tab + 1);
    if (!excluded(filePath))
      files[filePath] = entry.slice(0, tab).split(" ")[1]!;
  }
  const gone = new Set(splitNul(deleted));
  for (const filePath of gone) delete files[filePath];
  // An untracked file in a directory a build writes, which the project's
  // .gitignore misses, is the build's output, not an input.
  const toHash = [
    ...new Set([
      ...splitNul(changed),
      ...splitNul(untracked).filter((filePath) => !isGenerated(filePath)),
    ]),
  ].filter(
    (filePath) =>
      !gone.has(filePath) && !filePath.endsWith("/") && !excluded(filePath),
  );
  if (toHash.some((filePath) => filePath.includes("\n"))) {
    throw new Uncacheable("a file name in the repository has a line break");
  }
  if (toHash.length > 0) {
    const ids = (
      await git(
        root,
        ["hash-object", "--stdin-paths"],
        `${toHash.join("\n")}\n`,
      )
    )
      .trim()
      .split("\n");
    toHash.forEach((filePath, index) => {
      files[filePath] = ids[index]!;
    });
  }
  return files;
};

/** `KEY=VALUE` lines of a properties or `.env` file. */
const parseAssignments = (contents: string): [string, string][] =>
  contents.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s?(.*)$/.exec(
      line,
    );
    return match && !line.trim().startsWith("#")
      ? [[match[1]!, match[2]!.trim()] as [string, string]]
      : [];
  });

/**
 * The digest of a properties or `.env` file's settings, without its
 * credentials: a credential's name stays, its value never enters the key.
 */
const assignmentsDigest = (
  contents: string,
  root: string,
  omit: ReadonlySet<string> = new Set(),
) =>
  sha256(
    stableStringify(
      Object.fromEntries(
        parseAssignments(contents)
          .filter(([name]) => !omit.has(name))
          .map(([name, value]) => [
            name,
            isCredentialName(name) || isSecretValue(value)
              ? null
              : machineIndependent(value, root),
          ]),
      ),
    ),
  );

const readIfExists = (file: string) =>
  fs.readFile(file, "utf8").catch(() => null);

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/**
 * The native packages installed in node_modules: every dependency of the
 * app, and of its dependencies, that ships native code for the platform.
 * Autolinking links a subset of them; hashing each one's files, instead of
 * trusting its version, makes a local edit or a postinstall script rebuild.
 * Workspace packages are files of the repository already.
 */
const readNativePackages = async (
  cwd: string,
  platform: Platform,
  root: string,
  hashes: FileHashes,
): Promise<Record<string, string>> => {
  type Manifest = {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const readManifest = async (dir: string): Promise<Manifest | null> => {
    const contents = await readIfExists(path.join(dir, "package.json"));
    try {
      return contents === null ? null : (JSON.parse(contents) as Manifest);
    } catch {
      return null;
    }
  };
  // Node's lookup: each ancestor's node_modules, as pnpm's layout needs.
  const resolve = async (from: string, name: string) => {
    for (let dir = from; ; ) {
      if (path.basename(dir) !== "node_modules") {
        const candidate = path.join(dir, "node_modules", name);
        if (await exists(path.join(candidate, "package.json"))) {
          return fs.realpath(candidate);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  const otherPlatformDirs =
    platform === "ios" ? ["android"] : ["ios", "apple", "macos"];
  const isNative = async (dir: string) =>
    platform === "ios"
      ? (await fs.readdir(dir)).some((name) => name.endsWith(".podspec")) ||
        (await exists(path.join(dir, "ios"))) ||
        (await exists(path.join(dir, "apple")))
      : await exists(path.join(dir, "android"));

  const app = await readManifest(cwd);
  const seen = new Set<string>();
  const packages: Record<string, string> = {};
  let queue: { from: string; names: string[] }[] = [
    {
      from: cwd,
      names: Object.keys({
        ...app?.dependencies,
        ...app?.optionalDependencies,
        ...app?.devDependencies,
      }),
    },
  ];
  while (queue.length > 0) {
    const level = queue;
    queue = [];
    const resolved = await mapLimit(
      level.flatMap(({ from, names }) => names.map((name) => ({ from, name }))),
      32,
      async ({ from, name }) => resolve(from, name),
    );
    const dirs = [...new Set(resolved.filter((dir) => dir !== null))].filter(
      (dir) => !seen.has(dir),
    );
    for (const dir of dirs) seen.add(dir);
    await mapLimit(dirs, 8, async (dir) => {
      const manifest = await readManifest(dir);
      if (!manifest) return;
      queue.push({
        from: dir,
        names: Object.keys({
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
        }),
      });
      const installed = toPosix(dir).split("/").includes("node_modules");
      if (!installed || !(await isNative(dir))) return;
      const files = (
        await fg("**/*", {
          cwd: dir,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          ignore: [
            ...GENERATED_GLOBS,
            ...otherPlatformDirs.map((other) => `${other}/**`),
          ],
        })
      ).sort();
      const digests = await mapLimit(files, 16, (file) =>
        hashes.hash(path.join(dir, file)),
      );
      packages[
        `package:${manifest.name ?? toPosix(path.relative(root, dir))}@${manifest.version ?? "unknown"}`
      ] = sha256(
        files.map((file, index) => `${file}\0${digests[index]}`).join("\n"),
      );
    });
  }
  return packages;
};

/**
 * Inputs git ignores that change what the build produces: the native
 * projects' ignored files (all of them, for a project an adapter's prebuild
 * generates), `.env*` files, and the package manager's install state.
 */
const readIgnoredInputs = async ({
  cwd,
  root,
  platform,
  hashes,
  excluded,
}: {
  cwd: string;
  root: string;
  platform: Platform;
  hashes: FileHashes;
  excluded: (relativePath: string) => boolean;
}): Promise<Record<string, string>> => {
  const inputs: Record<string, string> = {};
  const nativeDir = platform === "ios" ? "ios" : "android";
  const fromRoot = (absolutePath: string) =>
    toPosix(path.relative(root, absolutePath));

  if (await exists(path.join(cwd, nativeDir))) {
    const ignored = splitNul(
      await git(cwd, [
        "ls-files",
        "-o",
        "-i",
        "--exclude-standard",
        "--directory",
        "-z",
        "--",
        nativeDir,
      ]),
    );
    const files: string[] = [];
    for (const entry of ignored) {
      const absolute = path.join(cwd, entry);
      if (isGenerated(fromRoot(absolute)) || excluded(fromRoot(absolute))) {
        continue;
      }
      if (entry.endsWith("/")) {
        for (const file of await fg("**/*", {
          cwd: absolute,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: false,
          ignore: GENERATED_GLOBS,
        })) {
          files.push(path.join(absolute, file));
        }
      } else {
        files.push(absolute);
      }
    }
    // local.properties names the SDK by an absolute path; the SDK's
    // components are part of the toolchain.
    const localProperties = path.join(cwd, "android", "local.properties");
    await mapLimit(files.sort(), 16, async (file) => {
      if (file === localProperties) return;
      inputs[`file:${fromRoot(file)}`] = await hashes.hash(file);
    });
    if (platform === "android") {
      const contents = await readIfExists(localProperties);
      if (contents !== null) {
        inputs["local.properties"] = assignmentsDigest(
          contents,
          root,
          new Set(["sdk.dir", "ndk.dir", "cmake.dir"]),
        );
      }
    }
  }

  for (const dir of new Set([cwd, root])) {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (!name.startsWith(".env")) continue;
      const file = path.join(dir, name);
      if (!(await fs.stat(file)).isFile()) continue;
      inputs[`env-file:${fromRoot(file)}`] = assignmentsDigest(
        await fs.readFile(file, "utf8"),
        root,
      );
    }
    // What the package manager installed. pnpm's .modules.yaml records an
    // absolute store path and a timestamp, so its lockfile copy stands in.
    for (const state of [
      ".pnpm/lock.yaml",
      ".package-lock.json",
      ".yarn-state.yml",
      ".yarn-integrity",
    ]) {
      const file = path.join(dir, "node_modules", state);
      if (await exists(file)) {
        inputs[`install-state:${fromRoot(file)}`] = await hashes.hash(file);
      }
    }
  }
  return inputs;
};

/** What the toolchain probes read the project from. */
export interface ToolchainContext {
  readonly cwd: string;
  readonly root: string;
  readonly simulator: boolean;
  readonly env: NodeJS.ProcessEnv;
}

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

const probe = async (command: string, args: string[], cwd: string) => {
  try {
    const { stdout, stderr } = await execa(command, args, { cwd });
    return (stdout || stderr).trim();
  } catch {
    return "unavailable";
  }
};

/** The JDK in `home`: its release file's version and vendor. */
const readJdk = async (home: string) => {
  const release = await readIfExists(path.join(home, "release"));
  if (release === null) return null;
  const values = Object.fromEntries(parseAssignments(release));
  return [
    values["IMPLEMENTOR"],
    values["JAVA_VERSION"],
    values["JAVA_RUNTIME_VERSION"],
  ]
    .filter(Boolean)
    .map((value) => value!.replace(/^"|"$/g, ""))
    .join(" ");
};

/**
 * The tools that build, by version: Xcode, its SDK, and CocoaPods, or the
 * JDK, the Android SDK's installed components, and Gradle's machine-wide
 * properties. The Node.js and Hot Updater versions are added by the caller.
 */
export const readToolchain = async (
  platform: Platform,
  { cwd, root, simulator, env }: ToolchainContext,
): Promise<Record<string, string>> => {
  if (platform === "ios") {
    const usesBundler = (
      await Promise.all(
        [path.join(cwd, "ios", "Gemfile"), path.join(cwd, "Gemfile")].map(
          async (file) => (await readIfExists(file))?.includes("cocoapods"),
        ),
      )
    ).some(Boolean);
    const [xcode, sdk, cocoapods] = await Promise.all([
      probe("xcodebuild", ["-version"], cwd),
      probe(
        "xcrun",
        [
          "--sdk",
          simulator ? "iphonesimulator" : "iphoneos",
          "--show-sdk-build-version",
        ],
        cwd,
      ),
      // A Gemfile pins CocoaPods in its Gemfile.lock, a file of the repository.
      usesBundler
        ? Promise.resolve("bundler")
        : probe("pod", ["--version"], path.join(cwd, "ios")),
    ]);
    return { xcode: xcode.replace(/\s+/g, " "), sdk, cocoapods };
  }

  const gradleHome =
    env["GRADLE_USER_HOME"] ?? path.join(os.homedir(), ".gradle");
  const userProperties = await readIfExists(
    path.join(gradleHome, "gradle.properties"),
  );
  const projectProperties = await readIfExists(
    path.join(cwd, "android", "gradle.properties"),
  );
  const javaHome = [userProperties, projectProperties]
    .map(
      (contents) =>
        contents &&
        Object.fromEntries(parseAssignments(contents))["org.gradle.java.home"],
    )
    .find(Boolean);
  const jdk =
    (await readJdk(javaHome ?? env["JAVA_HOME"] ?? "")) ??
    firstLine(await probe("java", ["-version"], cwd));

  const sdkRoot = env["ANDROID_HOME"] || env["ANDROID_SDK_ROOT"];
  const components: Record<string, string> = {};
  for (const component of ["build-tools", "platforms", "ndk", "cmake"]) {
    const names = sdkRoot
      ? await fs.readdir(path.join(sdkRoot, component)).catch(() => [])
      : [];
    components[`android-sdk:${component}`] = names.sort().join(",");
  }
  return {
    jdk,
    ...components,
    ...(userProperties === null
      ? {}
      : {
          "gradle.properties (user)": assignmentsDigest(
            userProperties,
            root,
            new Set(["org.gradle.java.home"]),
          ),
        }),
  };
};

/** The values of the environment variables the build reads: name → digest. */
const readEnv = async ({
  cwd,
  root,
  files,
  env,
  platform,
}: {
  cwd: string;
  root: string;
  files: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
  platform: Platform;
}): Promise<Record<string, string>> => {
  const names = new Set(
    Object.keys(env).filter(
      (name) =>
        ENV_NAMES.includes(name) ||
        ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  );
  const prefix = toPosix(path.relative(root, cwd));
  const inApp = (filePath: string) =>
    prefix === ""
      ? filePath
      : filePath.startsWith(`${prefix}/`)
        ? filePath.slice(prefix.length + 1)
        : null;
  const otherNativeDir = platform === "ios" ? "android/" : "ios/";

  type Scanned = {
    filePath: string;
    appPath: string;
    /** How the file reads the environment; null for app JavaScript. */
    reads: (typeof ENV_READS)[number] | null;
  };
  const scanned = Object.keys(files).flatMap((filePath): Scanned[] => {
    const appPath = inApp(filePath);
    if (appPath === null || appPath.startsWith(otherNativeDir)) return [];
    const reads = ENV_READS.find(({ pattern }) => pattern.test(appPath));
    if (reads) return [{ filePath, appPath, reads }];
    return SOURCE_FILE.test(appPath) &&
      !appPath.startsWith("ios/") &&
      !appPath.startsWith("android/") &&
      !/(^|\/)hot-updater\.config\.(c|m)?(j|t)s$/.test(appPath)
      ? [{ filePath, appPath, reads: null }]
      : [];
  });
  // A generated native project, which git ignores, configures the build too.
  for (const file of [
    path.join(cwd, "ios", "Podfile"),
    path.join(cwd, "ios", ".xcode.env.local"),
  ]) {
    const filePath = toPosix(path.relative(root, file));
    if (!(filePath in files) && (await exists(file))) {
      scanned.push({
        filePath,
        appPath: toPosix(path.relative(cwd, file)),
        reads: ENV_READS.find(({ pattern }) => pattern.test(filePath))!,
      });
    }
  }

  await mapLimit(scanned, 32, async ({ filePath, appPath, reads }) => {
    const contents = await readIfExists(path.join(root, filePath));
    if (contents === null) return;
    const dynamic = reads?.dynamic.find((pattern) => pattern.test(contents));
    if (dynamic) {
      throw new Uncacheable(
        `${appPath} reads environment variables by a computed name, which no key can follow`,
      );
    }
    for (const match of contents.matchAll(reads?.literal ?? SOURCE_ENV_READ)) {
      const name = match[1] ?? match[2];
      if (name && !SYSTEM_ENV_NAMES.has(name)) names.add(name);
    }
  });

  const values: Record<string, string> = {};
  for (const name of [...names].sort()) {
    const value = env[name];
    if (value === undefined || isCredentialName(name) || isSecretValue(value)) {
      continue;
    }
    values[name] = sha256(machineIndependent(value, root));
  }
  return values;
};

/** Device-list export methods: Xcode re-signs them as devices are added. */
const DEVICE_LIST_METHODS = new Set([
  "ad-hoc",
  "development",
  "release-testing",
  "debugging",
]);

const PROFILE_DIRS = [
  path.join(os.homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
  path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "UserData",
    "Provisioning Profiles",
  ),
];

/** The export options plist, or why the key can't read it. */
const readExportOptions = async (
  file: string,
): Promise<Record<string, unknown>> => {
  try {
    const parsed = plist.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new Uncacheable(
    `${path.basename(file)} is not an XML property list the key can read`,
  );
};

/**
 * The provisioning profiles installed on this machine whose name or UUID is
 * `reference`: their contents, which name the certificates and devices, are
 * no secret. A profile is a signed plist, whose `Name` and `UUID` read as text.
 */
const findProfiles = async (reference: string): Promise<Buffer[]> => {
  const found: Buffer[] = [];
  for (const dir of PROFILE_DIRS) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!/\.(mobileprovision|provisionprofile)$/.test(name)) continue;
      const contents = await fs.readFile(path.join(dir, name));
      const text = contents.toString("latin1");
      const read = (key: string) =>
        new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
          text,
        )?.[1];
      if (read("UUID") === reference || read("Name") === reference) {
        found.push(contents);
      }
    }
  }
  return found;
};

/** The SHA-256 of a keystore entry's certificate, read with the JDK's keytool. */
const readCertificateDigest = async (
  {
    storeFile,
    storePassword,
    keyAlias,
  }: NonNullable<NativeBuildKeySigning["androidKeystore"]>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const keytool = env["JAVA_HOME"]
    ? path.join(env["JAVA_HOME"], "bin", "keytool")
    : "keytool";
  try {
    // The password goes through the environment, never the command line.
    const { stdout } = await execa(
      keytool,
      [
        "-exportcert",
        "-rfc",
        "-alias",
        keyAlias,
        "-keystore",
        storeFile,
        "-storepass:env",
        "HOT_UPDATER_KEYTOOL_STOREPASS",
      ],
      { env: { HOT_UPDATER_KEYTOOL_STOREPASS: storePassword } },
    );
    const base64 = stdout
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
      .replace(/\s+/g, "");
    if (!base64) throw new Error("keytool printed no certificate");
    return sha256(Buffer.from(base64, "base64"));
  } catch (error) {
    throw new Uncacheable(
      `the release keystore's certificate could not be read with keytool (${error instanceof Error ? maskSecretValues(firstLine(error.message)) : "unknown error"})`,
    );
  }
};

const readSigning = async (
  input: NativeBuildKeyInput,
): Promise<Record<string, string>> => {
  const { platform, schemeConfig, signing } = input;
  const env = input.env ?? process.env;
  if (platform === "android") {
    if (!signing.androidKeystore) return {};
    return {
      certificate: await readCertificateDigest(signing.androidKeystore, env),
      alias: sha256(signing.androidKeystore.keyAlias),
    };
  }
  if (schemeConfig["simulator"] === true) return {};
  const identity: Record<string, string> = {};
  if (signing.ascApiKey) {
    identity["asc-api-key"] = sha256(
      `${signing.ascApiKey.issuerId}/${signing.ascApiKey.keyId}`,
    );
  }
  const exportOptionsPlist = schemeConfig["exportOptionsPlist"];
  const exportOptions =
    typeof exportOptionsPlist === "string"
      ? await readExportOptions(exportOptionsPlist)
      : {};
  const method =
    typeof exportOptions["method"] === "string"
      ? exportOptions["method"]
      : "app-store-connect";
  if (DEVICE_LIST_METHODS.has(method)) {
    throw new Uncacheable(
      `the export method ${method} signs for a list of devices, which changes outside the project`,
    );
  }
  identity["method"] = method;
  const profiles = exportOptions["provisioningProfiles"];
  if (
    exportOptions["signingStyle"] === "manual" ||
    (profiles && typeof profiles === "object")
  ) {
    for (const [bundleId, reference] of Object.entries(
      (profiles ?? {}) as Record<string, unknown>,
    ).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const found =
        typeof reference === "string" ? await findProfiles(reference) : [];
      if (found.length === 0) {
        throw new Uncacheable(
          `the provisioning profile ${String(reference)} for ${bundleId} is not installed on this machine`,
        );
      }
      identity[`profile:${bundleId}`] = sha256(
        found
          .map((contents) => sha256(contents))
          .sort()
          .join(","),
      );
    }
  }
  return identity;
};

/**
 * Settings of the scheme and what the build embeds: the scheme as the build
 * reads it, with paths relative to the repository, the contents of the
 * files it names, the artifact's kind, the channel, and the fingerprint or
 * app version.
 */
const readSettings = async (
  input: NativeBuildKeyInput,
  root: string,
): Promise<Record<string, string>> => {
  const settings: Record<string, string> = {};
  const scheme: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input.schemeConfig)) {
    if (typeof value === "string" && path.isAbsolute(value)) {
      scheme[name] = machineIndependent(value, root);
      const contents = await fs.readFile(value).catch(() => null);
      if (contents !== null) settings[`file:${name}`] = sha256(contents);
    } else {
      scheme[name] = value;
    }
  }
  for (const name of ["xcconfig"]) {
    const value = input.schemeConfig[name];
    if (typeof value === "string" && !path.isAbsolute(value)) {
      const contents = await fs
        .readFile(path.resolve(input.cwd, value))
        .catch(() => null);
      if (contents !== null) settings[`file:${name}`] = sha256(contents);
    }
  }
  const schemeJson = maskSecretValues(stableStringify(scheme));
  settings["scheme"] = sha256(schemeJson);
  settings["artifact"] = input.artifactKind;
  settings["channel"] = input.channel;
  if (input.fingerprintHash !== null) {
    settings["fingerprint"] = input.fingerprintHash;
  } else {
    settings["app-version"] = input.appVersion ?? "";
  }
  return settings;
};

/** A version Gradle resolves anew: `1.+`, `latest.release`, or a range. */
const DYNAMIC_VERSION = String.raw`(?:[^"'$\s]*\+|latest\.\w+|[[(][^"']*,[^"']*[\])])`;

/**
 * A dependency the app builds with whose version Gradle resolves anew, in a
 * build file or a version catalog. A test configuration's doesn't reach the
 * artifact, nor a variable no configuration names, such as the template's
 * `jscFlavor`.
 */
const DYNAMIC_GRADLE_VERSION = new RegExp(
  [
    String.raw`\b(?:implementation|api|compileOnly|runtimeOnly|classpath|annotationProcessor|kapt|ksp|coreLibraryDesugaring)\s*\(?\s*["'][\w.-]+:[\w.-]+:${DYNAMIC_VERSION}["']`,
    String.raw`^\s*[\w.-]+\s*=\s*["']${DYNAMIC_VERSION}["']`,
  ].join("|"),
  "m",
);

/**
 * Lockfiles a cached build needs: without them, the same files resolve to
 * other versions of the native dependencies on the next install.
 */
const checkPinned = async (
  cwd: string,
  platform: Platform,
  files: Readonly<Record<string, string>>,
  root: string,
) => {
  const relative = (file: string) => toPosix(path.relative(root, file));
  if (platform === "ios") {
    const iosDir = path.join(cwd, "ios");
    if (
      (await exists(path.join(iosDir, "Podfile"))) &&
      !(await exists(path.join(iosDir, "Podfile.lock")))
    ) {
      throw new Uncacheable(
        "ios/Podfile.lock is missing, so the pods resolve anew on each install",
      );
    }
    const projects = await fg(["*.xcodeproj/project.pbxproj"], { cwd: iosDir });
    for (const project of projects) {
      const contents = await fs.readFile(path.join(iosDir, project), "utf8");
      if (!contents.includes("XCRemoteSwiftPackageReference")) continue;
      const resolvedFiles = await fg(
        [
          "*.xcworkspace/xcshareddata/swiftpm/Package.resolved",
          "*.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
        ],
        { cwd: iosDir },
      );
      if (resolvedFiles.length === 0) {
        throw new Uncacheable(
          `ios/${project} uses Swift packages without a Package.resolved, so they resolve anew on each build`,
        );
      }
    }
    return;
  }
  const androidPrefix = `${relative(path.join(cwd, "android"))}/`;
  const gradleFiles = Object.keys(files).filter(
    (filePath) =>
      filePath.startsWith(androidPrefix) &&
      /(\.gradle(\.kts)?|\.versions\.toml)$/.test(filePath) &&
      !isGenerated(filePath),
  );
  const locked = Object.keys(files).some(
    (filePath) =>
      filePath.startsWith(androidPrefix) &&
      filePath.endsWith("gradle.lockfile"),
  );
  if (locked) return;
  for (const filePath of gradleFiles) {
    const contents = await readIfExists(path.join(root, filePath));
    if (contents && DYNAMIC_GRADLE_VERSION.test(contents)) {
      throw new Uncacheable(
        `${toPosix(path.relative(cwd, path.join(root, filePath)))} declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build`,
      );
    }
  }
};

/**
 * Computes the native build key of a prepared build: a SHA-256 of every
 * input that can change the artifact, and what it hashed, by component. It
 * is computed after the build adapter's prebuild and before the build. The
 * MIN_BUNDLE_ID, which each build issues anew, is not an input: a build that
 * matches keeps its own. Paths are relative to the repository, so another
 * machine computes the same key from the same inputs.
 */
export const computeNativeBuildKey = async (
  input: NativeBuildKeyInput,
): Promise<NativeBuildKey> => {
  const env = input.env ?? process.env;
  const { cwd, platform } = input;
  try {
    const buildType =
      platform === "ios"
        ? input.schemeConfig["configuration"]
        : input.schemeConfig["variant"];
    if (/debug$/i.test(String(buildType ?? "Release"))) {
      throw new Uncacheable("a Debug build loads its JavaScript from Metro");
    }
    let root: string;
    try {
      root = await fs.realpath(
        (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch {
      throw new Uncacheable("the project is not in a git repository");
    }
    const realCwd = await fs.realpath(cwd);
    const excludedPrefixes = [input.outputPath, input.cacheDir]
      .filter((dir): dir is string => dir !== null)
      .map((dir) => toPosix(path.relative(root, path.resolve(realCwd, dir))))
      .filter((relative) => relative && !relative.startsWith(".."));
    const excluded = (relativePath: string) =>
      relativePath.split("/").includes(".hot-updater") ||
      path.posix.basename(relativePath) === ".DS_Store" ||
      excludedPrefixes.some(
        (prefix) =>
          relativePath === prefix || relativePath.startsWith(`${prefix}/`),
      );

    const hashes = await FileHashes.open(
      input.cacheDir === null
        ? null
        : path.join(
            input.cacheDir,
            "native-build",
            platform,
            "file-hashes.json",
          ),
    );
    const files = await readRepositoryFiles(root, excluded);
    await checkPinned(realCwd, platform, files, root);
    const [ignored, nativePackages, settings, signing, env_, toolchain] =
      await Promise.all([
        readIgnoredInputs({ cwd: realCwd, root, platform, hashes, excluded }),
        readNativePackages(realCwd, platform, root, hashes),
        readSettings({ ...input, cwd: realCwd }, root),
        readSigning(input),
        readEnv({ cwd: realCwd, root, files, env, platform }),
        (input.readToolchain ?? readToolchain)(platform, {
          cwd: realCwd,
          root,
          simulator: input.schemeConfig["simulator"] === true,
          env,
        }),
      ]);
    await hashes.save();
    const components: NativeBuildKeyComponents = {
      engine: NATIVE_BUILD_KEY_ENGINE,
      files,
      inputs: { ...ignored, ...nativePackages },
      settings,
      signing,
      toolchain: {
        ...toolchain,
        node: process.version,
        os: `${os.platform()} ${os.release().split(".")[0]}`,
        arch: os.arch(),
        "hot-updater": input.hotUpdaterVersion,
      },
      env: env_,
    };
    return {
      key: `nbk1:${sha256(stableStringify(components))}`,
      components,
      uncacheable: null,
    };
  } catch (error) {
    if (error instanceof Uncacheable) {
      return { key: null, components: null, uncacheable: error.message };
    }
    throw error;
  }
};

/**
 * What differs between two keys' components, as `<component>:<name>`, such
 * as `file:src/App.tsx` or `env:EXPO_PUBLIC_API_URL`.
 */
export const diffNativeBuildKeyComponents = (
  previous: NativeBuildKeyComponents,
  next: NativeBuildKeyComponents,
): string[] => {
  if (previous.engine !== next.engine) return ["engine"];
  const changed: string[] = [];
  const compare = (
    label: string,
    before: Readonly<Record<string, string>> = {},
    after: Readonly<Record<string, string>> = {},
  ) => {
    for (const name of [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].sort()) {
      if (before[name] !== after[name]) changed.push(`${label}:${name}`);
    }
  };
  compare("file", previous.files, next.files);
  compare("input", previous.inputs, next.inputs);
  compare("setting", previous.settings, next.settings);
  compare("signing", previous.signing, next.signing);
  compare("toolchain", previous.toolchain, next.toolchain);
  compare("env", previous.env, next.env);
  return changed;
};

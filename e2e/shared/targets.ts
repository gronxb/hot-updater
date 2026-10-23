import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The identity every E2E target app shares, so the scenarios' deep links, the
 * driver and the bot need no per-target ids: one app on a device at a time.
 */
export const E2E_APP = {
  name: "HotUpdaterExample",
  androidPackage: "com.hotupdaterexample",
  iosBundleId: "org.reactjs.native.example.HotUpdaterExample",
  urlScheme: "hotupdaterexample",
} as const;

/** The target a run uses when nothing selects one. */
export const DEFAULT_E2E_TARGET = "v0.85.0";

/** The brownfield target `--track brownfield` selects. */
export const BROWNFIELD_E2E_TARGET = "brownfield-host";

/** The file under `examples/<target>` that makes the directory an E2E target. */
export const E2E_TARGET_MANIFEST = "e2e.json";

/** `examples/<target>/e2e.json`. Paths are relative to that directory. */
export type E2eTargetManifest = {
  /** The scenario suite the target runs: `default` or `brownfield`. */
  suite?: string;
  /** The React Native app whose JavaScript ships, when it is not this directory. */
  app?: string;
  ios?: {
    workspace?: string;
    scheme?: string;
    /** Environment for `pod install`, such as React Native's prebuilt core flags. */
    podEnv?: Record<string, string>;
  };
  /** Native sources the fingerprint hashes beyond the defaults. */
  fingerprintExtraSources?: { ios?: string[]; android?: string[] };
  /**
   * Native host apps embedding the app, packaged as an XCFramework and an
   * AAR. The installed binary is the host's.
   */
  brownfield?: {
    ios: { frameworkScheme: string; hostProject: string; hostScheme: string };
    android: { libraryTask: string; libraryBuildDir: string };
  };
};

/** A resolved target; every path is relative to the repository root. */
export type E2eTarget = {
  name: string;
  dir: string;
  /** The React Native app: hot-updater.config.ts, keys, .env.hotupdater, Gemfile. */
  appDir: string;
  suite: string;
  kind: "app" | "brownfield";
  ios: {
    /** Where `pod install` runs: the app's ios directory. */
    podsDir: string;
    /** Where the installed app builds: the app's, or the host's. */
    projectDir: string;
    workspace: string;
    scheme: string;
    podEnv: Record<string, string>;
  };
  android: {
    /** Where the installed APK builds: the app's, or the host's. */
    projectDir: string;
    apk: string;
  };
  fingerprintExtraSources: { ios: string[]; android: string[] };
  brownfield?: E2eTargetManifest["brownfield"] & {
    /** The app's native projects, which package the framework and the library. */
    libraryIosDir: string;
    libraryAndroidDir: string;
  };
};

export const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../", import.meta.url),
);

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readManifest(file: string): E2eTargetManifest {
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} must hold a JSON object`);
  }
  return value as E2eTargetManifest;
}

/** Loads `examples/<name>/e2e.json`. */
export function loadE2eTarget(
  name: string,
  repositoryRoot: string = REPOSITORY_ROOT,
): E2eTarget {
  if (!TARGET_NAME.test(name)) throw new Error(`Invalid E2E target: ${name}`);
  const dir = path.posix.join("examples", name);
  const file = path.join(repositoryRoot, dir, E2E_TARGET_MANIFEST);
  if (!existsSync(file)) {
    throw new Error(
      `Unknown E2E target ${name}: ${path.posix.join(dir, E2E_TARGET_MANIFEST)} does not exist`,
    );
  }
  const manifest = readManifest(file);
  const appDir = path.posix.normalize(
    path.posix.join(dir, manifest.app ?? "."),
  );
  const kind = manifest.brownfield ? "brownfield" : "app";
  const nativeDir = kind === "brownfield" ? dir : appDir;
  return {
    name,
    dir,
    appDir,
    suite: manifest.suite ?? (kind === "brownfield" ? "brownfield" : "default"),
    kind,
    ios: {
      podsDir: path.posix.join(appDir, "ios"),
      projectDir: path.posix.join(nativeDir, "ios"),
      workspace: manifest.ios?.workspace ?? `${E2E_APP.name}.xcworkspace`,
      scheme: manifest.ios?.scheme ?? E2E_APP.name,
      podEnv: manifest.ios?.podEnv ?? {},
    },
    android: {
      projectDir: path.posix.join(nativeDir, "android"),
      apk: path.posix.join(
        nativeDir,
        "android/app/build/outputs/apk/release/app-release.apk",
      ),
    },
    fingerprintExtraSources: {
      ios: manifest.fingerprintExtraSources?.ios ?? [],
      android: manifest.fingerprintExtraSources?.android ?? [],
    },
    ...(manifest.brownfield
      ? {
          brownfield: {
            ...manifest.brownfield,
            libraryIosDir: path.posix.join(appDir, "ios"),
            libraryAndroidDir: path.posix.join(appDir, "android"),
          },
        }
      : {}),
  };
}

/** Every directory under `examples/` with an `e2e.json`. */
export function listE2eTargets(
  repositoryRoot: string = REPOSITORY_ROOT,
  list: (dir: string) => string[] = (dir) =>
    readdirSync(path.join(repositoryRoot, dir)),
): string[] {
  return list("examples")
    .filter((name) =>
      existsSync(
        path.join(repositoryRoot, "examples", name, E2E_TARGET_MANIFEST),
      ),
    )
    .sort();
}

/**
 * The target a run selects:
 * 1. `--target`, or `HOT_UPDATER_E2E_TARGET`;
 * 2. `--track brownfield`, the brownfield target (the bot's existing flag);
 * 3. the example the bot wrote the env file into
 *    (`HOT_UPDATER_E2E_ENV_TARGET_RELATIVE_DIR`), when it is a target;
 * 4. `DEFAULT_E2E_TARGET`.
 */
export function resolveE2eTargetName(
  options: { target?: string; track?: string },
  env: NodeJS.ProcessEnv,
  repositoryRoot: string = REPOSITORY_ROOT,
): string {
  if (
    options.track !== undefined &&
    options.track !== "greenfield" &&
    options.track !== "brownfield"
  ) {
    throw new Error(`Unknown E2E track: ${options.track}`);
  }
  const explicit = options.target ?? env.HOT_UPDATER_E2E_TARGET;
  if (explicit) {
    if (options.track === "brownfield") {
      const target = loadE2eTarget(explicit, repositoryRoot);
      if (target.kind !== "brownfield") {
        throw new Error(
          `--track brownfield selects a brownfield target, not ${explicit}`,
        );
      }
    }
    return explicit;
  }
  if (options.track === "brownfield") return BROWNFIELD_E2E_TARGET;
  const envDir = env.HOT_UPDATER_E2E_ENV_TARGET_RELATIVE_DIR;
  const fromEnv = envDir && /^examples\/([^/]+)\/?$/.exec(envDir)?.[1];
  if (
    fromEnv &&
    existsSync(
      path.join(repositoryRoot, "examples", fromEnv, E2E_TARGET_MANIFEST),
    )
  ) {
    return fromEnv;
  }
  return DEFAULT_E2E_TARGET;
}

/**
 * The target of this process: `HOT_UPDATER_E2E_TARGET`, which the e2e entry
 * sets for itself and every child, or the default.
 */
export function currentE2eTarget(
  env: NodeJS.ProcessEnv = process.env,
  repositoryRoot: string = REPOSITORY_ROOT,
): E2eTarget {
  return loadE2eTarget(
    env.HOT_UPDATER_E2E_TARGET || DEFAULT_E2E_TARGET,
    repositoryRoot,
  );
}

/** The result's `track`, which the bot reads: the app shell. */
export function trackOf(target: E2eTarget): "greenfield" | "brownfield" {
  return target.kind === "brownfield" ? "brownfield" : "greenfield";
}

/**
 * The DerivedData directory of the iOS app a target installs;
 * `HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH` resolves against its project directory.
 */
export function iosDerivedDataDir(
  target: E2eTarget,
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  return path.resolve(
    repositoryRoot,
    target.ios.projectDir,
    env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH || "build",
  );
}

/** The built app the runner installs, unless a binary path overrides it. */
export function nativeAppPath(
  target: E2eTarget,
  platform: "ios" | "android",
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "ios") {
    return path.resolve(
      env.HOT_UPDATER_E2E_IOS_BINARY_PATH ??
        path.join(
          iosDerivedDataDir(target, repositoryRoot, env),
          `Build/Products/Release-iphonesimulator/${E2E_APP.name}.app`,
        ),
    );
  }
  return path.resolve(
    repositoryRoot,
    env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ?? target.android.apk,
  );
}

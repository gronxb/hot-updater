import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
}

export function deterministicArtifactSha256(artifactPath) {
  const root = path.resolve(artifactPath);
  const stat = fs.lstatSync(root);
  if (stat.isFile()) return hash(fs.readFileSync(root));
  if (!stat.isDirectory()) throw new Error(`Unsupported artifact: ${root}`);

  const digest = crypto.createHash("sha256");
  digest.update("hot-updater-native-artifact-v1\0");
  const visit = (directory, relativeDirectory) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const entryStat = fs.lstatSync(absolute);
      const type = entryStat.isDirectory()
        ? "directory"
        : entryStat.isFile()
          ? "file"
          : entryStat.isSymbolicLink()
            ? "symlink"
            : null;
      if (!type) throw new Error(`Unsupported artifact entry: ${relative}`);
      digest.update(frame(type));
      digest.update(frame(relative));
      digest.update(frame((entryStat.mode & 0o777).toString(8)));
      if (type === "file") digest.update(frame(fs.readFileSync(absolute)));
      if (type === "symlink") digest.update(frame(fs.readlinkSync(absolute)));
      if (type === "directory") visit(absolute, relative);
    }
  };
  visit(root, "");
  return digest.digest("hex");
}

export function iosArtifactAppId(appPath) {
  const result = spawnSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Info.plist")],
    { encoding: "utf8" },
  );
  const appId = result.stdout.trim();
  if (result.status !== 0 || !appId) {
    throw new Error(`Could not derive iOS application ID: ${result.stderr}`);
  }
  return appId;
}

export function parseAndroidApplicationId(output) {
  const badging = /package:\s+name='([^']+)'/.exec(output)?.[1];
  const direct = output.trim().match(/^[A-Za-z][A-Za-z0-9_.]+$/)?.[0];
  const appId = badging ?? direct;
  if (!appId) throw new Error("Could not parse Android application ID");
  return appId;
}

export function androidArtifactAppId(apkPath, environment = process.env) {
  const sdk = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  const candidates = [];
  if (sdk) {
    const analyzer = path.join(sdk, "cmdline-tools/latest/bin/apkanalyzer");
    if (fs.existsSync(analyzer)) {
      candidates.push([analyzer, ["manifest", "application-id", apkPath]]);
    }
    const buildTools = path.join(sdk, "build-tools");
    if (fs.existsSync(buildTools)) {
      for (const version of fs.readdirSync(buildTools).sort().reverse()) {
        for (const executable of ["aapt", "aapt2"]) {
          const tool = path.join(buildTools, version, executable);
          if (fs.existsSync(tool)) {
            candidates.push([tool, ["dump", "badging", apkPath]]);
          }
        }
      }
    }
  }
  candidates.push(["apkanalyzer", ["manifest", "application-id", apkPath]]);
  candidates.push(["aapt", ["dump", "badging", apkPath]]);
  candidates.push(["aapt2", ["dump", "badging", apkPath]]);
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) continue;
    try {
      return parseAndroidApplicationId(result.stdout);
    } catch {}
  }
  throw new Error("Could not derive Android application ID from the APK");
}

export function assertTrackedSourceClean(repoDir, allowedPaths = []) {
  const result = spawnSync("git", ["diff", "--name-only", "-z", "HEAD", "--"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Could not inspect tracked native source changes");
  }
  const allowed = new Set(allowedPaths);
  const changed = result.stdout.split("\0").filter(Boolean);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length) {
    throw new Error(
      `Runnable native artifacts require clean tracked source: ${unexpected.join(", ")}`,
    );
  }
  return { clean: true, trackedChanges: [], allowedTrackedChanges: changed };
}

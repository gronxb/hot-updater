import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { XMLParser, XMLValidator } from "fast-xml-parser";

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

function significantNodes(nodes) {
  return nodes.filter((node) => {
    const name = Object.keys(node).find((key) => key !== ":@");
    if (
      !name ||
      name === "#comment" ||
      name === "?xml" ||
      name === "!DOCTYPE"
    ) {
      return false;
    }
    return name !== "#text" || String(node[name]).trim();
  });
}

function elementText(node, name) {
  const children = node[name];
  if (!Array.isArray(children)) return null;
  if (
    children.some((child) =>
      Object.keys(child).some(
        (key) => key !== "#text" && key !== "#comment" && key !== ":@",
      ),
    )
  ) {
    return null;
  }
  const text = children
    .map((child) => child["#text"])
    .filter((value) => typeof value === "string")
    .join("")
    .trim();
  return text || null;
}

export function parseXmlPlistAppId(xml) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Invalid XML Info.plist: ${validation.err.msg}`);
  }
  const document = significantNodes(
    new XMLParser({
      commentPropName: "#comment",
      ignoreAttributes: false,
      preserveOrder: true,
      trimValues: false,
    }).parse(xml),
  );
  if (document.length !== 1 || !Array.isArray(document[0].plist)) {
    throw new Error("Info.plist must contain one plist root");
  }
  const plist = significantNodes(document[0].plist);
  if (plist.length !== 1 || !Array.isArray(plist[0].dict)) {
    throw new Error("Info.plist root must contain one dictionary");
  }

  const entries = significantNodes(plist[0].dict);
  if (entries.length % 2 !== 0) {
    throw new Error("Info.plist dictionary is malformed");
  }
  const appIds = [];
  for (let index = 0; index < entries.length; index += 2) {
    const key = elementText(entries[index], "key");
    const value = entries[index + 1];
    if (!key || !value) throw new Error("Info.plist dictionary is malformed");
    if (key === "CFBundleIdentifier") {
      const appId = elementText(value, "string");
      if (!appId) {
        throw new Error("CFBundleIdentifier must be a non-empty string");
      }
      appIds.push(appId);
    }
  }
  if (appIds.length !== 1) {
    throw new Error("Info.plist must contain one top-level CFBundleIdentifier");
  }
  return appIds[0];
}

export function iosArtifactAppId(appPath, run = spawnSync) {
  const infoPlistPath = path.join(appPath, "Info.plist");
  const bytes = fs.readFileSync(infoPlistPath);
  const text = bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (text.startsWith("<")) return parseXmlPlistAppId(text);

  const result = run(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", infoPlistPath],
    { encoding: "utf8" },
  );
  const appId = result.stdout?.trim();
  if (result.status !== 0 || !appId) {
    throw new Error(
      `Could not derive iOS application ID: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
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

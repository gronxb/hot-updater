import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { XMLBuilder, XMLParser } from "fast-xml-parser";
import plist from "plist";

export const nativePublicKeyPaths = {
  android: [
    "examples/lynx/android/app/src/main/AndroidManifest.xml",
    "examples/lynx/android/e2e-app/src/main/AndroidManifest.xml",
    "examples/lynx/android/matrix-app/src/main/AndroidManifest.xml",
  ],
  ios: [
    "examples/lynx/ios/Info.plist",
    "examples/lynx/ios/MatrixHarness/NonProductionInfo.plist",
  ],
};

const allNativePublicKeyPaths = Object.values(nativePublicKeyPaths).flat();
const xmlOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  format: true,
  indentBy: "    ",
  suppressEmptyNode: true,
};

const parser = new XMLParser(xmlOptions);
const builder = new XMLBuilder({
  ...xmlOptions,
  suppressBooleanAttributes: false,
  processEntities: true,
});
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function git(repoDir, args) {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    encoding: args[0] === "show" ? null : "utf8",
  });
  if (result.status !== 0) throw new Error("Could not inspect native source");
  return result.stdout;
}

function androidApplication(document) {
  const application = document.manifest?.application;
  return Array.isArray(application) ? application[0] : application;
}

function readAndroidKey(bytes) {
  const application = androidApplication(parser.parse(bytes.toString("utf8")));
  const values = application?.["meta-data"];
  const entries = values ? (Array.isArray(values) ? values : [values]) : [];
  const matches = entries.filter(
    (entry) => entry["@_android:name"] === "com.hotupdater.PUBLIC_KEY",
  );
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 ||
    typeof matches[0]["@_android:value"] !== "string"
  ) {
    throw new Error("Expected one Android Hot Updater public key");
  }
  return matches[0]["@_android:value"].trim();
}

function injectAndroidKey(bytes, publicKey) {
  const document = parser.parse(bytes.toString("utf8"));
  const application = androidApplication(document);
  if (!application) throw new Error("Android manifest has no application");
  const values = application["meta-data"];
  const entries = values ? (Array.isArray(values) ? values : [values]) : [];
  const existingIndex = entries.findIndex(
    (entry) => entry["@_android:name"] === "com.hotupdater.PUBLIC_KEY",
  );
  const entry = {
    "@_android:name": "com.hotupdater.PUBLIC_KEY",
    "@_android:value": publicKey,
  };
  if (existingIndex === -1) entries.push(entry);
  else entries[existingIndex] = entry;
  application["meta-data"] = entries.length === 1 ? entries[0] : entries;
  return Buffer.from(builder.build(document));
}

function readIosKey(bytes) {
  const document = plist.parse(bytes.toString("utf8"));
  if (!Object.hasOwn(document, "HOT_UPDATER_PUBLIC_KEY")) return null;
  const value = document.HOT_UPDATER_PUBLIC_KEY;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected one iOS Hot Updater public key");
  }
  return value.trim();
}

function injectIosKey(bytes, publicKey) {
  const document = plist.parse(bytes.toString("utf8"));
  document.HOT_UPDATER_PUBLIC_KEY = publicKey;
  return Buffer.from(plist.build(document, { indent: "\t", pretty: true }));
}

function validatePublicKey(value) {
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch {
    throw new Error("Native Hot Updater public key is invalid");
  }
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error(
      "Native Hot Updater public key must be RSA 2048 or stronger",
    );
  }
  const canonical = key
    .export({ format: "pem", type: "spki" })
    .toString()
    .trim();
  if (canonical !== value) {
    throw new Error("Native Hot Updater public key must be canonical SPKI PEM");
  }
  return {
    algorithm: "rsa-spki",
    modulusLength: key.asymmetricKeyDetails.modulusLength,
    spkiSha256: sha256(key.export({ format: "der", type: "spki" })),
  };
}

function parseHeadTree(repoDir, checkedCommit) {
  const entries = new Map();
  for (const record of String(
    git(repoDir, ["ls-tree", "-rz", "--full-tree", checkedCommit]),
  )
    .split("\0")
    .filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Could not inspect native source");
    entries.set(match[3], { mode: match[1], objectId: match[2] });
  }
  return entries;
}

function parseIndex(repoDir) {
  const entries = new Map();
  for (const record of String(git(repoDir, ["ls-files", "--stage", "-z"]))
    .split("\0")
    .filter(Boolean)) {
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0") {
      throw new Error("Could not inspect native source");
    }
    entries.set(match[4], { mode: match[1], objectId: match[2] });
  }
  return entries;
}

function hashRegularFiles(repoDir, files) {
  if (files.some((file) => file.includes("\n") || file.includes("\r"))) {
    throw new Error("Tracked paths with line breaks are unsupported");
  }
  if (files.length === 0) return new Map();
  const result = spawnSync("git", ["hash-object", "--stdin-paths"], {
    cwd: repoDir,
    encoding: "utf8",
    input: `${files.join("\n")}\n`,
    maxBuffer: 16 * 1024 * 1024,
  });
  const hashes = result.stdout?.trim().split("\n") ?? [];
  if (
    result.status !== 0 ||
    hashes.length !== files.length ||
    hashes.some((hash) => !/^[0-9a-f]+$/.test(hash))
  ) {
    throw new Error("Could not inspect native source");
  }
  return new Map(files.map((file, index) => [file, hashes[index]]));
}

function assertNoGitFilters(repoDir, files) {
  if (files.length === 0) return;
  const input = Buffer.from(`${files.join("\0")}\0`);
  const result = spawnSync("git", ["check-attr", "-z", "--stdin", "filter"], {
    cwd: repoDir,
    encoding: null,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error("Could not inspect native source");
  }
  const fields = result.stdout.toString("utf8").split("\0");
  if (fields.at(-1) !== "") {
    throw new Error("Could not inspect native source");
  }
  fields.pop();
  if (fields.length !== files.length * 3) {
    throw new Error("Could not inspect native source");
  }
  for (const [index, file] of files.entries()) {
    const offset = index * 3;
    if (fields[offset] !== file || fields[offset + 1] !== "filter") {
      throw new Error("Could not inspect native source");
    }
    if (fields[offset + 2] !== "unspecified") {
      throw new Error(`Tracked source uses a Git filter attribute: ${file}`);
    }
  }
}

function assertNoAmbiguousUnspecifiedFilter(repoDir) {
  const result = spawnSync(
    "git",
    [
      "config",
      "-z",
      "--name-only",
      "--get-regexp",
      "^[Ff][Ii][Ll][Tt][Ee][Rr]\\.[Uu][Nn][Ss][Pp][Ee][Cc][Ii][Ff][Ii][Ee][Dd]\\.",
    ],
    { cwd: repoDir, encoding: null, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status === 0) {
    throw new Error("Git filter driver name 'unspecified' is reserved");
  }
  if (result.status !== 1) {
    throw new Error("Could not inspect native source");
  }
}

function currentTreeEntry(repoDir, file, objectFormat, regularObjectIds) {
  const absolutePath = path.join(repoDir, file);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return null;
  }
  const mode = stat.isSymbolicLink()
    ? "120000"
    : stat.isFile()
      ? stat.mode & 0o111
        ? "100755"
        : "100644"
      : null;
  if (!mode) return null;
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(absolutePath))
    : fs.readFileSync(absolutePath);
  const objectId = stat.isSymbolicLink()
    ? crypto
        .createHash(objectFormat)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex")
    : regularObjectIds.get(file);
  if (!objectId) throw new Error("Could not inspect native source");
  return { bytes, mode, objectId };
}

function inspectTrackedTree(repoDir, checkedCommit) {
  const objectFormat = String(
    git(repoDir, ["rev-parse", "--show-object-format"]),
  ).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error("Could not inspect native source");
  }
  const head = parseHeadTree(repoDir, checkedCommit);
  const index = parseIndex(repoDir);
  const allPaths = [...new Set([...head.keys(), ...index.keys()])];
  assertNoAmbiguousUnspecifiedFilter(repoDir);
  assertNoGitFilters(repoDir, allPaths);
  const regularObjectIds = hashRegularFiles(
    repoDir,
    allPaths.filter((file) => {
      try {
        return fs.lstatSync(path.join(repoDir, file)).isFile();
      } catch {
        return false;
      }
    }),
  );
  const current = new Map();
  const changed = [];
  for (const [file, expected] of head) {
    const observed = currentTreeEntry(
      repoDir,
      file,
      objectFormat,
      regularObjectIds,
    );
    if (observed) current.set(file, observed);
    if (
      !observed ||
      observed.mode !== expected.mode ||
      observed.objectId !== expected.objectId ||
      index.get(file)?.mode !== expected.mode ||
      index.get(file)?.objectId !== expected.objectId
    ) {
      changed.push(file);
    }
  }
  for (const file of index.keys()) {
    if (!head.has(file)) {
      changed.push(file);
      const observed = currentTreeEntry(
        repoDir,
        file,
        objectFormat,
        regularObjectIds,
      );
      if (observed) current.set(file, observed);
    }
  }
  return {
    changed: [...new Set(changed)].sort(),
    current,
    head,
    index,
    sha256: sha256(
      Buffer.from(
        [...current.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, entry]) => {
            const indexed = index.get(file);
            return `${file}\0${entry.mode}\0${entry.objectId}\0${indexed?.mode ?? "missing"}\0${indexed?.objectId ?? "missing"}\n`;
          })
          .join(""),
      ),
    ),
  };
}

export function assertNativePublicKeyOnlySourceChanges(
  repoDir,
  checkedCommit,
  allowedPaths = [],
) {
  const trackedTree = inspectTrackedTree(repoDir, checkedCommit);
  const changed = trackedTree.changed;
  const allowed = new Set(allowedPaths);
  const nativeChanged = changed.filter((file) =>
    allNativePublicKeyPaths.includes(file),
  );
  const unexpected = changed.filter(
    (file) => !allowed.has(file) && !allNativePublicKeyPaths.includes(file),
  );
  if (unexpected.length) {
    throw new Error(
      `Runnable native artifacts require clean tracked source: ${unexpected.join(", ")}`,
    );
  }
  const current = Object.fromEntries(
    allNativePublicKeyPaths.map((file) => {
      const entry = trackedTree.current.get(file);
      if (!entry) throw new Error(`Missing native configuration: ${file}`);
      return [file, entry.bytes];
    }),
  );
  const keys = allNativePublicKeyPaths.map((file) =>
    file.includes("/android/")
      ? readAndroidKey(current[file])
      : readIosKey(current[file]),
  );
  if (nativeChanged.length === 0) {
    if (keys.some((key) => key !== null)) {
      throw new Error(
        "Committed Lynx E2E native configurations must not contain a public key",
      );
    }
    return {
      clean: true,
      trackedChanges: [],
      allowedTrackedChanges: changed,
      trackedTreeSha256: trackedTree.sha256,
    };
  }
  if (nativeChanged.length !== allNativePublicKeyPaths.length) {
    throw new Error("Public-key export must update every native configuration");
  }

  if (keys.some((key) => key === null)) {
    throw new Error(
      "Expected one Hot Updater public key in every native configuration",
    );
  }
  if (new Set(keys).size !== 1) {
    throw new Error("Native public-key exports do not match");
  }
  const publicKey = keys[0];
  const identity = validatePublicKey(publicKey);
  const files = {};
  for (const file of allNativePublicKeyPaths) {
    if (
      trackedTree.current.get(file).mode !== trackedTree.head.get(file).mode ||
      trackedTree.index.get(file)?.mode !== trackedTree.head.get(file).mode ||
      trackedTree.index.get(file)?.objectId !==
        trackedTree.head.get(file).objectId
    ) {
      throw new Error(`${file} changed outside the public-key export`);
    }
    const head = git(repoDir, ["show", `${checkedCommit}:${file}`]);
    const expected = file.includes("/android/")
      ? injectAndroidKey(head, publicKey)
      : injectIosKey(head, publicKey);
    if (!expected.equals(current[file])) {
      throw new Error(`${file} changed outside the public-key export`);
    }
    files[file] = sha256(current[file]);
  }
  return {
    clean: true,
    trackedChanges: [],
    allowedTrackedChanges: changed.filter((file) => allowed.has(file)),
    trackedTreeSha256: trackedTree.sha256,
    nativePublicKeyInjection: {
      schemaVersion: 1,
      provenance: "post-fingerprint-trust-anchor-injection",
      runtimeFingerprintRecalculated: false,
      ...identity,
      files,
    },
  };
}

export function assertNativePublicKeySourceUnchanged(
  repoDir,
  checkedCommit,
  allowedPaths,
  expected,
) {
  const observed = assertNativePublicKeyOnlySourceChanges(
    repoDir,
    checkedCommit,
    allowedPaths,
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("Tracked source changed during the native build");
  }
  return observed;
}

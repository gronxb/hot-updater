import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { brotliDecompressSync } from "node:zlib";

import {
  encodeChannelKey,
  NIL_UUID,
} from "../../../packages/core/dist/index.mjs";
import { createDatabaseClient } from "../../../plugins/plugin-core/dist/index.mjs";
import { standaloneRepository } from "../../../plugins/standalone/dist/index.mjs";

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    signed: { type: "boolean" },
    channel: { type: "string" },
    "runtime-id": { type: "string" },
  },
});
const [framework, platform, format = "zip", fixture = "B-external2-managed"] =
  positionals;
if (
  !["react", "vue", "octane"].includes(framework) ||
  !["ios", "android"].includes(platform) ||
  !["zip", "tar.gz", "tar.br"].includes(format) ||
  !/^[A-Za-z0-9-]+$/.test(fixture) ||
  positionals.length > 4
) {
  throw new Error(
    "Usage: node scripts/ota-deploy.mjs <react|vue|octane> <ios|android> [zip|tar.gz|tar.br] [frozen-fixture-name] [--signed] [--channel <native-channel>] [--runtime-id <native-profile>]",
  );
}
const example = fileURLToPath(new URL("../", import.meta.url));
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const root = path.join(example, ".hot-updater/ota");
const signed = options.signed === true;
if (
  /sdk\d/.test(fixture) &&
  (!options["runtime-id"]?.trim() ||
    !options.channel?.trim() ||
    options["runtime-id"].includes("-spike"))
) {
  throw new Error(
    "SDK fixtures require explicit --runtime-id and --channel matching the new native OTA configuration.",
  );
}
if (/sdk3/.test(fixture) && !options["runtime-id"]?.endsWith("-ota-v2")) {
  throw new Error(
    "SDK3 fixtures require the native ota-v2 compatibility profile.",
  );
}
const privateKeyPath = path.join(root, "signing/private-key.pem");
const publicKeyPath = path.join(root, "signing/public-key.pem");
let publicKey;
if (signed) {
  await fs.mkdir(path.dirname(privateKeyPath), {
    recursive: true,
    mode: 0o700,
  });
  try {
    await fs.access(privateKeyPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    try {
      await fs.writeFile(privateKeyPath, keys.privateKey, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
    }
  }
  publicKey = crypto.createPublicKey(await fs.readFile(privateKeyPath));
  await fs.writeFile(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
  );
}
const origin = "http://127.0.0.1:18791";
const source = await fs.realpath(
  path.join(example, ".hot-updater/g1", framework, fixture),
);
const runtimeId =
  options["runtime-id"] ??
  (platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-spike1");
const label = `${framework}-${platform}-${fixture}-${format.replaceAll(".", "-")}${signed ? "-signed" : ""}`;
const channel = options.channel ?? `lynx-${label}`;
const project = path.join(root, "projects", `${label}-${crypto.randomUUID()}`);
await fs.mkdir(project, { recursive: true });
await fs.writeFile(
  path.join(project, "package.json"),
  JSON.stringify({ name: `lynx-ota-${label}`, private: true, type: "module" }),
);
// Exercise the public Lynx key resolver with the actual native projects present.
for (const nativePlatform of ["ios", "android"])
  await fs.symlink(
    path.join(example, nativePlatform),
    path.join(project, nativePlatform),
  );
const nativeConfigPath = path.join(
  project,
  platform === "ios"
    ? "ios/Info.plist"
    : "android/app/src/main/AndroidManifest.xml",
);
const nativeConfigBytes = await fs.readFile(nativeConfigPath);
const moduleUrl = (relative) =>
  pathToFileURL(path.join(workspace, relative)).href;
const tokenPath = path.join(root, "admin-token");
const token = (await fs.readFile(tokenPath, "utf8")).trim();
const commonHeaders = { authorization: `Bearer ${token}` };
const repository = standaloneRepository({
  baseUrl: `${origin}/hot-updater/admin`,
  commonHeaders,
});
const database = createDatabaseClient(repository);
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const verifyToken = (bytes, token) => {
  if (signed) {
    assert.ok(
      token.startsWith("sig:"),
      "Configured signing must produce a signature token",
    );
    assert.ok(
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(sha256(bytes), "hex"),
        publicKey,
        Buffer.from(token.slice(4), "base64"),
      ),
      "CLI signature must verify with the native public key",
    );
  } else {
    assert.equal(sha256(bytes), token);
  }
};
const collect = async (directory) => {
  const files = {};
  for (const name of (
    await fs.readdir(directory, { recursive: true })
  ).sort()) {
    const absolute = path.join(directory, name);
    if ((await fs.lstat(absolute)).isFile())
      files[name.split(path.sep).join("/")] = await fs.readFile(absolute);
  }
  return files;
};
const sourceFiles = await collect(source);
const config = `import fs from "node:fs/promises";
import path from "node:path";
import { lynx } from ${JSON.stringify(moduleUrl("packages/lynx/dist/build.mjs"))};
import { standaloneRepository, standaloneStorage } from ${JSON.stringify(moduleUrl("plugins/standalone/dist/index.mjs"))};
const token = (await fs.readFile(${JSON.stringify(tokenPath)}, "utf8")).trim();
const commonHeaders = { authorization: "Bearer " + token };
export default {
  updateStrategy: "appVersion",
  compressStrategy: ${JSON.stringify(format)},
  patch: { enabled: false },
  ${signed ? `signing: { enabled: true, privateKeyPath: ${JSON.stringify(privateKeyPath)} },` : ""}
  build: ({ cwd }) => {
    const plugin = lynx({
      ${signed ? `getBundleSigningPublicKey: async () => ({ publicKey: await fs.readFile(${JSON.stringify(publicKeyPath)}, "utf8") }),` : ""}
      build: async ({ outDir }) => {
      await fs.cp(${JSON.stringify(source)}, outDir, { recursive: true });
      return { entry: "main.lynx.bundle", runtimeId: ${JSON.stringify(runtimeId)} };
    } })({ cwd });
    return { ...plugin,
      build: async (args) => {
      const result = await plugin.build(args);
      await fs.writeFile(path.join(cwd, "build-result.json"), JSON.stringify(result, null, 2));
      return result;
    } };
  },
  database: standaloneRepository({ baseUrl: ${JSON.stringify(`${origin}/hot-updater/admin`)}, commonHeaders }),
  storage: standaloneStorage({ baseUrl: ${JSON.stringify(`${origin}/storage`)}, protocol: "lynx-local", commonHeaders }),
};
`;
await fs.writeFile(path.join(project, "hot-updater.config.mjs"), config);
const cli = path.join(workspace, "packages/hot-updater/dist/index.mjs");
const args = [
  cli,
  "deploy",
  "-p",
  platform,
  "-t",
  "1.0.x",
  "-c",
  channel,
  "-o",
  path.join(project, "output"),
  "-m",
  `Lynx real compiler packaging ${label}`,
];
const logPath = path.join(project, "cli.log");
const log = await fs.open(logPath, "wx");
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: project,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`CLI deploy failed (${code ?? signal}); read ${logPath}`),
          ),
    );
  });
} finally {
  await log.close();
}

const build = JSON.parse(
  await fs.readFile(path.join(project, "build-result.json"), "utf8"),
);
assert.equal(build.filePolicy, "preserve");
const bundle = await database.getBundleById(build.bundleId);
assert.ok(bundle, "CLI bundle must exist in persisted provider state");
const releases = await repository.models.releases.findMany({
  bundleId: build.bundleId,
  limit: 10,
});
assert.equal(releases.length, 1);
const release = releases[0];
const catalogUrl = `${origin}/hot-updater/release-catalogs/app-version/${platform}/${encodeChannelKey(channel)}/1.0.0`;
const getJson = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, `HTTP ${url}`);
  return response.json();
};
const catalog = await getJson(catalogUrl);
assert.ok(
  catalog.releases.some(
    (row) => row.releaseId === release.id && row.bundleId === bundle.id,
  ),
);
const artifactUrl = `${origin}/hot-updater/artifacts/${bundle.id}/from/${NIL_UUID}`;
const artifact = await getJson(artifactUrl);
assert.equal(artifact.fileHash, bundle.fileHash);
if (artifact.manifestFileHash !== undefined) {
  assert.equal(artifact.manifestFileHash, bundle.manifestFileHash);
}
const download = await fetch(artifact.fileUrl);
assert.equal(download.status, 200);
const archiveBytes = Buffer.from(await download.arrayBuffer());
verifyToken(archiveBytes, bundle.fileHash);
assert.equal(archiveBytes.length, bundle.archiveByteSize);
const downloadedPath = path.join(project, `downloaded.${format}`);
await fs.writeFile(downloadedPath, archiveBytes);
const cliRequire = createRequire(
  new URL("../../../packages/cli-tools/package.json", import.meta.url),
);
let archive;
if (format === "zip") {
  const zip = await cliRequire("jszip").loadAsync(archiveBytes);
  archive = Object.fromEntries(
    await Promise.all(
      Object.entries(zip.files)
        .filter(([, file]) => !file.dir)
        .map(async ([name, file]) => [name, await file.async("nodebuffer")]),
    ),
  );
} else {
  const extract = path.join(project, "extracted");
  await fs.mkdir(extract);
  const tarPath = path.join(project, "downloaded.tar");
  if (format === "tar.br")
    await fs.writeFile(tarPath, brotliDecompressSync(archiveBytes));
  await cliRequire("tar").extract({
    file: format === "tar.br" ? tarPath : downloadedPath,
    cwd: extract,
    gzip: format === "tar.gz",
  });
  archive = await collect(extract);
}
assert.deepEqual(
  Object.keys(archive).sort(),
  [
    ...Object.keys(sourceFiles),
    "hot-updater-lynx.json",
    "manifest.json",
  ].sort(),
);
const manifest = JSON.parse(archive["manifest.json"].toString());
const metadata = JSON.parse(archive["hot-updater-lynx.json"].toString());
assert.equal(manifest.bundleId, bundle.id);
assert.deepEqual(metadata, {
  schemaVersion: 1,
  bundleId: bundle.id,
  platform,
  entry: "main.lynx.bundle",
  runtimeId,
});
verifyToken(archive["manifest.json"], bundle.manifestFileHash);
assert.deepEqual(
  Object.keys(manifest.assets).sort(),
  [...Object.keys(sourceFiles), "hot-updater-lynx.json"].sort(),
);
for (const [name, bytes] of Object.entries(sourceFiles))
  assert.deepEqual(archive[name], bytes, name);
for (const [name, asset] of Object.entries(manifest.assets)) {
  assert.equal(asset.fileHash, sha256(archive[name]), name);
  if (signed) verifyToken(archive[name], `sig:${asset.signature}`);
}
assert.deepEqual(
  await collect(source),
  sourceFiles,
  "Frozen compiler output must remain unchanged",
);
const receipt = {
  verifiedAt: new Date().toISOString(),
  framework,
  platform,
  fixture,
  format,
  signed,
  ...(signed ? { publicKeyPath } : {}),
  bundleId: bundle.id,
  releaseId: release.id,
  runtimeId,
  channel,
  fileUrl: artifact.fileUrl,
  fileHash: artifact.fileHash,
  manifestFileHash: artifact.manifestFileHash ?? null,
  persistedManifestFileHash: bundle.manifestFileHash,
  artifactResponse: artifact,
  artifactUrl,
  catalogUrl,
  catalogId: catalog.catalogId,
  scopeKey: catalog.scopeKey,
  generation: catalog.generation,
  catalogHash: catalog.catalogHash,
  archiveByteSize: archiveBytes.length,
  archiveSha256: sha256(archiveBytes),
  source,
  project,
  nativeConfig: { path: nativeConfigPath, sha256: sha256(nativeConfigBytes) },
  logPath,
  invocation: { executable: process.execPath, args, cwd: project },
  files: Object.fromEntries(
    Object.entries(archive).map(([name, bytes]) => [
      name,
      { byteSize: bytes.length, sha256: sha256(bytes) },
    ]),
  ),
};
const receipts = path.join(root, "receipts");
await fs.mkdir(receipts, { recursive: true });
await fs.writeFile(
  path.join(project, "verified-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
const receiptPath = path.join(receipts, `${label}.json`);
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
if (fixture === "B-external2-managed" && format === "zip")
  await fs.writeFile(
    path.join(
      receipts,
      `${framework}-${platform}${signed ? "-signed" : ""}.json`,
    ),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
console.log(
  JSON.stringify(
    {
      receiptPath,
      bundleId: bundle.id,
      releaseId: release.id,
      fileUrl: artifact.fileUrl,
      fileHash: artifact.fileHash,
      manifestFileHash: artifact.manifestFileHash ?? null,
      sourceFileCount: Object.keys(sourceFiles).length,
    },
    null,
    2,
  ),
);

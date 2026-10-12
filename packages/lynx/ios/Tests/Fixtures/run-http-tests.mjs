// Usage: node run-http-tests.mjs <absolute CLI fixture directory> [swift test args]
// Input: react-ios, react-ios-signed, vue-ios {json,manifest.json,tar.br,catalog.json},
// public-key.pem and embedded-react-a/. Positive payloads remain real CLI output;
// negative payloads are mutations of that output, never device acceptance evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";

const fixtureDirectory = process.argv[2];
assert(
  fixtureDirectory && path.isAbsolute(fixtureDirectory),
  "Provide an absolute CLI fixture directory",
);
const repo = path.resolve(import.meta.dirname, "../../../../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value));
const payloads = new Map();
const receipts = new Map();
const transfers = new Map();
let base;

for (const name of ["react-ios", "react-ios-signed", "vue-ios"]) {
  const request = JSON.parse(
    await fs.readFile(path.join(fixtureDirectory, `${name}.json`)),
  );
  const manifestBytes = await fs.readFile(
    path.join(fixtureDirectory, `${name}.manifest.json`),
  );
  const manifest = JSON.parse(manifestBytes);
  const archive = await fs.readFile(
    path.join(fixtureDirectory, `${name}.tar.br`),
  );
  assert.equal(sha(manifestBytes), request.files["manifest.json"].sha256);
  assert.equal(sha(archive), manifest.archive.downloadFileHash);
  assert.equal(archive.length, manifest.archive.downloadByteSize);
  const tar = brotliDecompressSync(archive);
  assert.equal(tar.length, manifest.archive.tarByteSize);
  const files = new Map();
  // The CLI emits regular USTAR entries and directories. Reject other fixture
  // encodings here instead of attempting to emulate the production TAR parser.
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const entry = header.subarray(0, 100).toString().split("\0")[0];
    const size = Number.parseInt(
      header.subarray(124, 136).toString().replace(/\0.*$/, ""),
      8,
    );
    if (header[156] === 53) {
      assert.equal(size, 0);
      continue;
    }
    assert(header[156] === 0 || header[156] === 48);
    assert(Object.hasOwn(manifest.assets, entry) && !files.has(entry), entry);
    const bytes = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    assert.equal(bytes.length, size);
    assert.equal(size, manifest.assets[entry].byteSize);
    assert.equal(sha(bytes), manifest.assets[entry].fileHash);
    files.set(entry, bytes);
  }
  assert.equal(files.size, Object.keys(manifest.assets).length);
  payloads.set(new URL(request.manifestUrl).pathname, manifestBytes);
  payloads.set(new URL(request.archiveUrl).pathname, archive);
  payloads.set(
    new URL(request.catalogUrl).pathname,
    await fs.readFile(path.join(fixtureDirectory, `${name}.catalog.json`)),
  );
  const originals = new Map();
  for (const [entry, descriptor] of Object.entries(request.assets)) {
    const bytes =
      descriptor.file.compression === "br"
        ? brotliCompressSync(files.get(entry))
        : files.get(entry);
    const asset = manifest.assets[entry];
    assert.equal(sha(bytes), asset.downloadFileHash ?? asset.fileHash);
    assert.equal(bytes.length, asset.downloadByteSize);
    payloads.set(new URL(descriptor.file.url).pathname, bytes);
    originals.set(entry, bytes);
  }
  receipts.set(name, request);
  if (name === "react-ios")
    base = { request, manifest, archive, tar, files, originals };
}
receipts.set(
  "react-ios-B-external2-managed-tar-br-signed",
  receipts.get("react-ios-signed"),
);

function tarEntry(name, bytes = Buffer.alloc(0), type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000644\0", 100);
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}

const negatives = [];
function add(name, mutate) {
  const prefix = `/negative/${name}`;
  const request = structuredClone(base.request.artifactResponse);
  request.bundleId = base.request.bundleId;
  const manifest = structuredClone(base.manifest);
  delete manifest.archive;
  delete request.archiveUrl;
  request.manifestUrl = prefix + "/manifest";
  const originals = new Map(base.originals);
  for (const [entry, descriptor] of Object.entries(request.assets)) {
    descriptor.file.url = `${prefix}/original/${entry}`;
  }
  const edit = {
    request,
    manifest,
    originals,
    archive: null,
    manifestBytes: null,
  };
  mutate(edit);
  const manifestBytes = edit.manifestBytes ?? json(manifest);
  request.manifestFileHash = sha(manifestBytes);
  payloads.set(request.manifestUrl, manifestBytes);
  for (const [entry, bytes] of originals)
    payloads.set(`${prefix}/original/${entry}`, bytes);
  if (edit.archive) {
    request.archiveUrl = prefix + "/archive";
    payloads.set(request.archiveUrl, edit.archive);
    // Ensure the optional bulk is actually eligible for selection, not silently
    // bypassed because of an impossible size/cost descriptor.
    assert(
      manifest.archive.downloadByteSize > 0 && manifest.archive.tarByteSize > 0,
    );
    assert(
      manifest.archive.downloadByteSize <=
        [...originals.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    );
  }
  negatives.push({ name, request });
  transfers.set(name, {});
}
const duplicate = (object, key) =>
  Buffer.from(
    `{${JSON.stringify(key)}:${JSON.stringify(object[key])},${JSON.stringify(object).slice(1)}`,
  );
const deep = (object) =>
  Buffer.from(
    `{"nested":${"[".repeat(40)}0${"]".repeat(40)},${JSON.stringify(object).slice(1)}`,
  );
add("duplicate-bundle-key", (edit) => {
  edit.manifestBytes = duplicate(edit.manifest, "bundleId");
});
add("duplicate-asset-hash-key", (edit) => {
  const text = JSON.stringify(edit.manifest);
  edit.manifestBytes = Buffer.from(
    text.replace(/"fileHash":"([^"]+)"/, '"fileHash":"$1","fileHash":"$1"'),
  );
});
add("deep-manifest", (edit) => {
  edit.manifestBytes = deep(edit.manifest);
});
add("oversized-manifest", (edit) => {
  edit.manifestBytes = json({
    ...edit.manifest,
    padding: "x".repeat(1024 * 1024),
  });
});
add("manifest-bundle-mismatch", (edit) => {
  edit.manifest.bundleId = "00000000-0000-0000-0000-000000000000";
});
add("missing-sidecar", (edit) => {
  delete edit.manifest.assets["hot-updater-lynx.json"];
});
add("descriptor-coverage", (edit) => {
  delete edit.request.assets["detail.lynx.bundle"];
});
add("descriptor-hash-mismatch", (edit) => {
  edit.request.assets["detail.lynx.bundle"].fileHash = "0".repeat(64);
});

function sidecar(name, mutate) {
  add(name, (edit) => {
    const entry = "hot-updater-lynx.json";
    const bytes = mutate(JSON.parse(base.files.get(entry)));
    const fileHash = sha(bytes);
    edit.originals.set(entry, bytes);
    edit.manifest.assets[entry] = {
      fileHash,
      byteSize: bytes.length,
      downloadByteSize: bytes.length,
      downloadCompression: null,
    };
    edit.request.assets[entry].fileHash = fileHash;
  });
}
sidecar("duplicate-entry-key", (value) => duplicate(value, "entry"));
sidecar("duplicate-sidecar-bundle-key", (value) =>
  duplicate(value, "bundleId"),
);
sidecar("deep-sidecar", deep);
sidecar("oversized-sidecar", (value) =>
  json({ ...value, padding: "x".repeat(16 * 1024) }),
);
sidecar("wrong-platform", (value) => json({ ...value, platform: "android" }));
sidecar("wrong-runtime", (value) =>
  json({ ...value, runtimeId: "other-native-runtime" }),
);
sidecar("missing-page", (value) =>
  json({ ...value, pageEntries: ["detail.lynx.bundle"] }),
);

function bulk(edit, tar, body = brotliCompressSync(tar)) {
  edit.archive = body;
  edit.manifest.archive = {
    downloadFileHash: sha(body),
    downloadByteSize: body.length,
    tarByteSize: tar.length,
  };
}
const prepend = (entry) => Buffer.concat([entry, base.tar]);
for (const [name, tar] of [
  ["pax-short", prepend(tarEntry("PaxHeader", Buffer.from("1 path=x\n"), "x"))],
  [
    "pax-overflow",
    prepend(
      tarEntry(
        "PaxHeader",
        Buffer.from("999999999999999999999999999999 path=x\n"),
        "x",
      ),
    ),
  ],
  ["path-traversal", prepend(tarEntry("../escaped"))],
  ["absolute-path", prepend(tarEntry("/escaped"))],
  ["symlink", prepend(tarEntry("link", Buffer.alloc(0), "2"))],
  [
    "duplicate-entry",
    prepend(
      tarEntry("detail.lynx.bundle", base.files.get("detail.lynx.bundle")),
    ),
  ],
  ["unlisted-entry", prepend(tarEntry("unlisted.txt"))],
  ["truncated-tar", base.tar.subarray(0, base.tar.length - 1)],
])
  add(name, (edit) => bulk(edit, tar));
const badChecksum = Buffer.from(base.tar);
badChecksum[0] ^= 1;
add("bad-checksum", (edit) => bulk(edit, badChecksum));
add("corrupt-transfer", (edit) => {
  bulk(edit, base.tar, Buffer.from(base.archive));
  edit.archive[0] ^= 1; // Deliberately retain the original authenticated hash.
});
add("unsupported-zip", (edit) => {
  const zip = Buffer.alloc(22);
  zip.writeUInt32LE(0x06054b50);
  bulk(edit, base.tar, zip);
});
add("unsupported-gzip", (edit) => bulk(edit, base.tar, gzipSync(base.tar)));
add("corrupt-original-after-archive", (edit) => {
  bulk(edit, badChecksum);
  const bytes = Buffer.from(edit.originals.get("detail.lynx.bundle"));
  bytes[0] ^= 1;
  edit.originals.set("detail.lynx.bundle", bytes);
});

let origin;
function rebase(request) {
  const copy = structuredClone(request);
  for (const key of ["manifestUrl", "archiveUrl", "catalogUrl"]) {
    if (copy[key]) copy[key] = origin + new URL(copy[key], origin).pathname;
  }
  for (const asset of Object.values(copy.assets))
    asset.file.url = origin + new URL(asset.file.url, origin).pathname;
  return copy;
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, origin).pathname;
  const negative = /^\/negative\/([^/]+)\/(.+)$/.exec(pathname);
  if (negative && transfers.has(negative[1])) {
    const counts = transfers.get(negative[1]);
    if (negative[2] === "requests") {
      res.end(json(counts));
      return;
    }
    counts[negative[2]] = (counts[negative[2]] ?? 0) + 1;
  }
  const network = /^\/qa\/(slow|truncated)\/(.+)$/.exec(pathname);
  const receipt = /^\/receipts\/(.+)\.json$/.exec(pathname);
  const bytes =
    pathname === "/files/qa/ios/index.json"
      ? json(
          negatives.map(({ name, request }) => ({
            name,
            request: rebase(request),
          })),
        )
      : receipt && receipts.has(receipt[1])
        ? json(rebase(receipts.get(receipt[1])))
        : payloads.get(network ? "/files/" + network[2] : pathname);
  if (!bytes) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-length": bytes.length, connection: "close" });
  if (!network) {
    res.end(bytes);
    return;
  }
  if (network[1] === "truncated") {
    res.end(bytes.subarray(0, Math.floor(bytes.length / 2)));
    return;
  }
  let offset = 0;
  const step = Math.ceil(bytes.length / 16);
  const write = () => {
    const end = Math.min(bytes.length, offset + step);
    res.write(bytes.subarray(offset, end));
    offset = end;
    if (offset === bytes.length) res.end();
  };
  const timer = setInterval(write, 400);
  res.once("close", () => clearInterval(timer));
  write();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(
    JSON.stringify({
      origin,
      negativeCases: negatives.map(({ name }) => name),
    }),
  );
  const child = spawn(
    "swift",
    ["test", "--package-path", "packages/lynx/ios", ...process.argv.slice(3)],
    {
      cwd: repo,
      stdio: "inherit",
      env: {
        ...process.env,
        LYNX_ARTIFACT_TEST_ORIGIN: origin,
        LYNX_ARTIFACT_TEST_PUBLIC_KEY: path.join(
          fixtureDirectory,
          "public-key.pem",
        ),
        LYNX_CONTROLLER_EMBEDDED: path.join(
          fixtureDirectory,
          "embedded-react-a",
        ),
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  console.log(
    JSON.stringify({ negativeRequests: Object.fromEntries(transfers) }),
  );
}

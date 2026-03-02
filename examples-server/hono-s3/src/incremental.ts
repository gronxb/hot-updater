import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import { hdiff } from "@hot-updater/bsdiff/node";
import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  Platform,
} from "@hot-updater/core";
import type { Context } from "hono";
import JSZip from "jszip";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { brotliDecompressSync } from "node:zlib";
import { hotUpdater, metadataBucketName, metadataS3Client } from "./db.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const CACHE_PREFIX = "incremental/cache";
const CONTENT_PREFIX = "incremental/content";

const INCREMENTAL_SIGNING_KEY_PATH_ENV = "HOT_UPDATER_PATCH_PRIVATE_KEY_PATH";

type ArchiveFormat = "zip" | "tar.gz" | "tar.br";

type IncrementalFileEntry = {
  path: string;
  size: number;
  hash: string;
  signedHash: string;
};

type IncrementalPayload = {
  fromBundleId: string;
  toBundleId: string;
  platform: Platform;
  jsBundlePath: string;
  contentBaseUrl: string;
  patch: {
    hash: string;
    signedHash: string;
    sourceHash: string;
    targetHash: string;
    targetSignedHash: string;
  };
  files: IncrementalFileEntry[];
};

type IncrementalResponse =
  | { mode: "none" }
  | { mode: "full"; full: AppUpdateInfo }
  | {
      mode: "incremental";
      full: AppUpdateInfo;
      incremental: IncrementalPayload;
    };

type IncrementalCachePayload = Omit<IncrementalPayload, "contentBaseUrl">;

let cachedPrivateKey: string | null | undefined;

function getContentBaseUrl(c: Context): string {
  const requestUrl = new URL(c.req.url);
  return `${requestUrl.origin}/hot-updater/incremental/content`;
}

function createSignedHash(signature: string): string {
  return `sig:${signature}`;
}

function sha256Hex(input: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function getPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey !== undefined) {
    return cachedPrivateKey;
  }

  const keyPath = process.env[INCREMENTAL_SIGNING_KEY_PATH_ENV];
  if (!keyPath) {
    cachedPrivateKey = null;
    return null;
  }

  try {
    const key = await fs.readFile(keyPath, "utf8");
    cachedPrivateKey = key;
    return key;
  } catch {
    cachedPrivateKey = null;
    return null;
  }
}

function signHashHex(hashHex: string, privateKeyPem: string): string {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(Buffer.from(hashHex, "hex"));
  sign.end();
  return sign.sign(privateKeyPem).toString("base64");
}

function detectArchiveFormatFromPath(filePath: string): ArchiveFormat | null {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".tar.br") || lower.endsWith(".br")) {
    return "tar.br";
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".gz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }

  return null;
}

function parseS3StorageUri(storageUri: string): { bucket: string; key: string } | null {
  if (!storageUri.startsWith("s3://")) {
    return null;
  }

  const withoutScheme = storageUri.slice("s3://".length);
  const firstSlash = withoutScheme.indexOf("/");
  if (firstSlash === -1) {
    return null;
  }

  const bucket = withoutScheme.slice(0, firstSlash);
  const key = withoutScheme.slice(firstSlash + 1);

  if (!bucket || !key) {
    return null;
  }

  return { bucket, key };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (
    body &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray: () => Promise<Uint8Array> })
      .transformToByteArray === "function"
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }

  throw new Error("Unsupported S3 body stream type");
}

async function loadS3Bytes(key: string): Promise<Buffer | null> {
  try {
    const result = await metadataS3Client.send(
      new GetObjectCommand({
        Bucket: metadataBucketName,
        Key: key,
      }),
    );

    if (!result.Body) {
      return null;
    }

    return await streamToBuffer(result.Body);
  } catch (error) {
    const maybe = error as Partial<S3ServiceException> & { name?: string };
    if (maybe.name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}

async function putS3Bytes(
  key: string,
  body: Uint8Array | Buffer,
  contentType = "application/octet-stream",
): Promise<void> {
  await metadataS3Client.send(
    new PutObjectCommand({
      Bucket: metadataBucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "max-age=31536000",
    }),
  );
}

async function loadS3Json<T>(key: string): Promise<T | null> {
  const bytes = await loadS3Bytes(key);
  if (!bytes) {
    return null;
  }

  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function putS3Json<T>(key: string, value: T): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  await putS3Bytes(key, bytes, "application/json");
}

async function fetchHttpBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP download failed: ${response.status} ${response.statusText}`);
  }
  const arr = new Uint8Array(await response.arrayBuffer());
  return Buffer.from(arr);
}

async function loadBundleArchive(bundle: Bundle): Promise<{
  bytes: Buffer;
  format: ArchiveFormat;
}> {
  const fromS3 = parseS3StorageUri(bundle.storageUri);

  if (fromS3) {
    const result = await metadataS3Client.send(
      new GetObjectCommand({
        Bucket: fromS3.bucket,
        Key: fromS3.key,
      }),
    );

    if (!result.Body) {
      throw new Error(`Bundle object body missing for ${bundle.storageUri}`);
    }

    const bytes = await streamToBuffer(result.Body);
    const format = detectArchiveFormatFromPath(fromS3.key);
    if (!format) {
      throw new Error(`Unsupported archive extension for key: ${fromS3.key}`);
    }

    return { bytes, format };
  }

  const url = new URL(bundle.storageUri);
  if (url.protocol === "http:" || url.protocol === "https:") {
    const bytes = await fetchHttpBytes(bundle.storageUri);
    const format = detectArchiveFormatFromPath(url.pathname);
    if (!format) {
      throw new Error(`Unsupported archive extension for path: ${url.pathname}`);
    }

    return { bytes, format };
  }

  throw new Error(`Unsupported storage protocol in ${bundle.storageUri}`);
}

async function collectFiles(
  rootDir: string,
  currentDir: string,
  output: Map<string, Buffer>,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDir, abs, output);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relative = path.relative(rootDir, abs).split(path.sep).join("/");
    const bytes = await fs.readFile(abs);
    output.set(relative, bytes);
  }
}

async function extractArchiveToFiles(
  bytes: Buffer,
  format: ArchiveFormat,
): Promise<Map<string, Buffer>> {
  if (format === "zip") {
    const zip = await JSZip.loadAsync(bytes);
    const files = new Map<string, Buffer>();
    const tasks: Promise<void>[] = [];

    zip.forEach((name, entry) => {
      if (entry.dir) {
        return;
      }

      tasks.push(
        (async () => {
          const normalized = name.replace(/\\/g, "/");
          const fileBytes = await entry.async("nodebuffer");
          files.set(normalized, fileBytes);
        })(),
      );
    });

    await Promise.all(tasks);

    return files;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-inc-"));
  const archivePath = path.join(tempRoot, `bundle.${format === "tar.br" ? "tar.br" : "tar.gz"}`);
  const extractDir = path.join(tempRoot, "extract");

  await fs.mkdir(extractDir, { recursive: true });

  try {
    if (format === "tar.gz") {
      await fs.writeFile(archivePath, bytes);
      await tar.x({ file: archivePath, cwd: extractDir, gzip: true });
    } else {
      const tarBytes = brotliDecompressSync(bytes);
      const tarPath = path.join(tempRoot, "bundle.tar");
      await fs.writeFile(tarPath, tarBytes);
      await tar.x({ file: tarPath, cwd: extractDir });
    }

    const files = new Map<string, Buffer>();
    await collectFiles(extractDir, extractDir, files);
    return files;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function resolveJsBundlePath(platform: Platform, filePaths: string[]): string | null {
  const normalized = filePaths.map((p) => p.replace(/\\/g, "/"));

  if (platform === "android") {
    const exact = normalized.find((file) => file === "index.android.bundle");
    if (exact) return exact;

    const nested = normalized.find((file) => file.endsWith("/index.android.bundle"));
    return nested ?? null;
  }

  const iosCandidates = ["index.ios.bundle", "main.jsbundle"];
  for (const candidate of iosCandidates) {
    const exact = normalized.find((file) => file === candidate);
    if (exact) return exact;

    const nested = normalized.find((file) => file.endsWith(`/${candidate}`));
    if (nested) return nested;
  }

  return normalized.find((file) => file.endsWith(".bundle")) ?? null;
}

function createCacheKey(platform: Platform, fromBundleId: string, toBundleId: string): string {
  return `${CACHE_PREFIX}/${platform}/${fromBundleId}/${toBundleId}.json`;
}

function createContentKey(hash: string): string {
  return `${CONTENT_PREFIX}/${hash}`;
}

async function ensureContentStored(hash: string, bytes: Uint8Array | Buffer): Promise<void> {
  const key = createContentKey(hash);
  if (await hasS3Object(key)) {
    return;
  }
  await putS3Bytes(key, bytes, "application/octet-stream");
}

async function hasS3Object(key: string): Promise<boolean> {
  try {
    await metadataS3Client.send(
      new HeadObjectCommand({
        Bucket: metadataBucketName,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    const maybe = error as Partial<S3ServiceException> & {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };

    if (
      maybe.name === "NotFound" ||
      maybe.name === "NoSuchKey" ||
      maybe.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }

    throw error;
  }
}

function normalizePlatform(platformRaw: string): Platform | null {
  if (platformRaw === "ios" || platformRaw === "android") {
    return platformRaw;
  }
  return null;
}

function toAppVersionArgs(
  params: Record<string, string>,
): AppVersionGetBundlesArgs | null {
  const platform = normalizePlatform(params.platform);
  const appVersion = params.appVersion;
  if (!platform || !appVersion) {
    return null;
  }

  return {
    _updateStrategy: "appVersion",
    platform,
    appVersion,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
  };
}

function toFingerprintArgs(
  params: Record<string, string>,
): FingerprintGetBundlesArgs | null {
  const platform = normalizePlatform(params.platform);
  const fingerprintHash = params.fingerprintHash;
  if (!platform || !fingerprintHash) {
    return null;
  }

  return {
    _updateStrategy: "fingerprint",
    platform,
    fingerprintHash,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
  };
}

async function buildIncrementalResponse(
  c: Context,
  args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
): Promise<IncrementalResponse> {
  const full = await hotUpdater.getAppUpdateInfo(args);
  if (!full) {
    return { mode: "none" };
  }

  if (
    full.status !== "UPDATE" ||
    !full.fileUrl ||
    !full.fileHash ||
    args.bundleId === NIL_UUID ||
    args.bundleId === full.id
  ) {
    return { mode: "full", full };
  }

  const privateKey = await getPrivateKey();
  if (!privateKey) {
    return { mode: "full", full };
  }

  const [fromBundle, toBundle] = await Promise.all([
    hotUpdater.getBundleById(args.bundleId),
    hotUpdater.getBundleById(full.id),
  ]);

  if (!fromBundle || !toBundle) {
    return { mode: "full", full };
  }

  const cacheKey = createCacheKey(args.platform, fromBundle.id, toBundle.id);
  const cached = await loadS3Json<IncrementalCachePayload>(cacheKey);

  if (cached) {
    return {
      mode: "incremental",
      full,
      incremental: {
        ...cached,
        contentBaseUrl: getContentBaseUrl(c),
      },
    };
  }

  let fromArchive: { bytes: Buffer; format: ArchiveFormat };
  let toArchive: { bytes: Buffer; format: ArchiveFormat };

  try {
    [fromArchive, toArchive] = await Promise.all([
      loadBundleArchive(fromBundle),
      loadBundleArchive(toBundle),
    ]);
  } catch {
    return { mode: "full", full };
  }

  let baseFiles: Map<string, Buffer>;
  let targetFiles: Map<string, Buffer>;

  try {
    [baseFiles, targetFiles] = await Promise.all([
      extractArchiveToFiles(fromArchive.bytes, fromArchive.format),
      extractArchiveToFiles(toArchive.bytes, toArchive.format),
    ]);
  } catch {
    return { mode: "full", full };
  }

  const jsBundlePath = resolveJsBundlePath(args.platform, Array.from(targetFiles.keys()));
  if (!jsBundlePath) {
    return { mode: "full", full };
  }

  const baseJsBytes = baseFiles.get(jsBundlePath);
  const targetJsBytes = targetFiles.get(jsBundlePath);

  if (!baseJsBytes || !targetJsBytes) {
    return { mode: "full", full };
  }

  const sourceHash = sha256Hex(baseJsBytes);
  const targetHash = sha256Hex(targetJsBytes);

  let patchBytes: Uint8Array;
  try {
    patchBytes = await hdiff(baseJsBytes, targetJsBytes);
  } catch {
    return { mode: "full", full };
  }

  const patchHash = sha256Hex(patchBytes);
  const patchSignedHash = createSignedHash(signHashHex(patchHash, privateKey));
  const targetSignedHash = createSignedHash(signHashHex(targetHash, privateKey));

  await ensureContentStored(patchHash, patchBytes);

  const files: IncrementalFileEntry[] = [];
  const sortedEntries = Array.from(targetFiles.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [filePath, fileBytes] of sortedEntries) {
    const fileHash = sha256Hex(fileBytes);
    const signedHash = createSignedHash(signHashHex(fileHash, privateKey));

    files.push({
      path: filePath,
      size: fileBytes.byteLength,
      hash: fileHash,
      signedHash,
    });

    await ensureContentStored(fileHash, fileBytes);
  }

  const cachedPayload: IncrementalCachePayload = {
    fromBundleId: fromBundle.id,
    toBundleId: toBundle.id,
    platform: args.platform,
    jsBundlePath,
    patch: {
      hash: patchHash,
      signedHash: patchSignedHash,
      sourceHash,
      targetHash,
      targetSignedHash,
    },
    files,
  };

  await putS3Json(cacheKey, cachedPayload);

  return {
    mode: "incremental",
    full,
    incremental: {
      ...cachedPayload,
      contentBaseUrl: getContentBaseUrl(c),
    },
  };
}

function isHexHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export async function handleIncrementalAppVersion(c: Context): Promise<Response> {
  const params = c.req.param();
  const args = toAppVersionArgs(params);

  if (!args) {
    return c.json({ error: "Invalid parameters" }, 400);
  }

  const result = await buildIncrementalResponse(c, args);
  return c.json(result, 200);
}

export async function handleIncrementalFingerprint(c: Context): Promise<Response> {
  const params = c.req.param();
  const args = toFingerprintArgs(params);

  if (!args) {
    return c.json({ error: "Invalid parameters" }, 400);
  }

  const result = await buildIncrementalResponse(c, args);
  return c.json(result, 200);
}

export async function handleIncrementalContent(c: Context): Promise<Response> {
  const { hash } = c.req.param();
  if (!hash || !isHexHash(hash)) {
    return c.json({ error: "Invalid hash" }, 400);
  }

  const bytes = await loadS3Bytes(createContentKey(hash));
  if (!bytes) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}

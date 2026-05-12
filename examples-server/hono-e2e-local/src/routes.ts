import fs from "fs/promises";
import path from "path";

import { Hono } from "hono";

import { hotUpdater } from "./db.js";

const app = new Hono();
const port = Number(process.env.PORT) || 3007;
const publicBaseUrl = (
  process.env.HOT_UPDATER_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`
).replace(/\/$/, "");
const hotUpdaterStoreTraces: HotUpdaterStoreTrace[] = [];
const storageRoot = path.resolve(
  process.env.HOT_UPDATER_E2E_STORAGE_DIR ??
    path.join(process.cwd(), "storage"),
);

type HotUpdaterStoreTraceFile = {
  downloadPath?: string;
  path?: string;
  progress?: number;
  status?: string;
};

type HotUpdaterStoreTrace = {
  artifactType?: string | null;
  details?: {
    completedFilesCount?: number;
    files?: HotUpdaterStoreTraceFile[];
    totalFilesCount?: number;
  } | null;
  isUpdateDownloaded?: boolean;
  progress?: number;
  runtimeBundleId?: string;
  source?: string;
  timestamp?: number;
};

function resolveWithinStorage(relativePath: string) {
  const resolvedPath = path.resolve(storageRoot, relativePath);
  const storagePrefix = `${storageRoot}${path.sep}`;
  if (resolvedPath !== storageRoot && !resolvedPath.startsWith(storagePrefix)) {
    throw new Error(
      `Refusing to access path outside storage root: ${relativePath}`,
    );
  }
  return resolvedPath;
}

function storageFileForKey(key: string, filename: string) {
  const normalizedKey = key.split("/").filter(Boolean).join(path.sep);
  const normalizedFilename = path.basename(filename);
  return resolveWithinStorage(path.join(normalizedKey, normalizedFilename));
}

function storageUriForKey(key: string, filename: string) {
  const encodedKey = key.split("/").filter(Boolean).join("/");
  const encodedFilename = encodeURIComponent(path.basename(filename));
  return `${publicBaseUrl}/storage/${encodedKey}/${encodedFilename}`;
}

function relativeStoragePathFromUri(storageUri: string) {
  const url = new URL(storageUri);
  const prefix = "/storage/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected storage URI: ${storageUri}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

async function removeEmptyStorageParents(targetPath: string) {
  let currentPath = path.dirname(targetPath);

  while (currentPath.startsWith(storageRoot) && currentPath !== storageRoot) {
    try {
      const entries = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentPath);
    } catch {
      return;
    }

    currentPath = path.dirname(currentPath);
  }
}

app.on(["GET", "POST", "PATCH", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

app.post("/e2e/hot-updater-store-trace", async (c) => {
  const payload = (await c.req.json()) as HotUpdaterStoreTrace;
  hotUpdaterStoreTraces.push({
    artifactType: payload.artifactType ?? null,
    details: payload.details ?? null,
    isUpdateDownloaded: payload.isUpdateDownloaded,
    progress: payload.progress,
    runtimeBundleId: payload.runtimeBundleId,
    source: payload.source,
    timestamp: Date.now(),
  });

  if (hotUpdaterStoreTraces.length > 500) {
    hotUpdaterStoreTraces.splice(0, hotUpdaterStoreTraces.length - 500);
  }

  return c.json({ ok: true });
});

app.get("/e2e/hot-updater-store-traces", (c) => {
  return c.json({ traces: hotUpdaterStoreTraces });
});

app.delete("/e2e/hot-updater-store-traces", (c) => {
  hotUpdaterStoreTraces.length = 0;
  return c.json({ ok: true });
});

app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const key = formData.get("key");
  const file = formData.get("file");

  if (typeof key !== "string" || key.length === 0 || !(file instanceof File)) {
    return c.json({ error: "Missing upload key or file" }, 400);
  }

  const targetPath = storageFileForKey(key, file.name);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));

  return c.json({ storageUri: storageUriForKey(key, file.name) });
});

app.delete("/delete", async (c) => {
  const payload = (await c.req.json()) as { storageUri?: string };
  if (!payload.storageUri) {
    return c.json({ error: "Missing storageUri" }, 400);
  }

  const relativeStoragePath = relativeStoragePathFromUri(payload.storageUri);
  const targetPath = resolveWithinStorage(relativeStoragePath);
  await fs.rm(targetPath, { force: true, recursive: true });
  await removeEmptyStorageParents(targetPath);

  return c.json({ ok: true });
});

app.post("/getDownloadUrl", async (c) => {
  const payload = (await c.req.json()) as { storageUri?: string };
  if (!payload.storageUri) {
    return c.json({ error: "Missing storageUri" }, 400);
  }

  return c.json({ fileUrl: payload.storageUri });
});

app.get("/storage/*", async (c) => {
  const relativeStoragePath = c.req.path.replace(/^\/storage\//, "");
  const targetPath = resolveWithinStorage(relativeStoragePath);

  try {
    const data = await fs.readFile(targetPath);
    const body = new Uint8Array(data);
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
      },
      status: 200,
    });
  } catch {
    return c.notFound();
  }
});

export default app;

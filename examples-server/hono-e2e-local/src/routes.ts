import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import {
  getJob,
  handleAssertCrashHistory,
  handleAssertLaunchReport,
  handleAssertMetadataActive,
  handleCaptureBuiltInBundleId,
  handleCaptureState,
  handleCleanup,
  handleWaitForMetadata,
  handleWriteSummary,
  startBootstrapJob,
  startDeployJob,
} from "./e2e-controller.js";
import { hotUpdater } from "./db.js";

const app = new Hono();
const port = Number(process.env.PORT) || 3007;
const publicBaseUrl = (
  process.env.HOT_UPDATER_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`
).replace(/\/$/, "");
const storageRoot = path.resolve(
  process.env.HOT_UPDATER_E2E_STORAGE_DIR ?? path.join(process.cwd(), "storage"),
);

function resolveWithinStorage(relativePath: string) {
  const resolvedPath = path.resolve(storageRoot, relativePath);
  const storagePrefix = `${storageRoot}${path.sep}`;
  if (resolvedPath !== storageRoot && !resolvedPath.startsWith(storagePrefix)) {
    throw new Error(`Refusing to access path outside storage root: ${relativePath}`);
  }
  return resolvedPath;
}

function storageFileForKey(key: string) {
  const normalizedKey = key.split("/").filter(Boolean).join(path.sep);
  return resolveWithinStorage(path.join(normalizedKey, "bundle.tar.br"));
}

function storageUriForKey(key: string) {
  const encodedKey = key.split("/").filter(Boolean).join("/");
  return `${publicBaseUrl}/storage/${encodedKey}/bundle.tar.br`;
}

function relativeStoragePathFromUri(storageUri: string) {
  const url = new URL(storageUri);
  const prefix = "/storage/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected storage URI: ${storageUri}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

app.on(["GET", "POST", "PATCH", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const key = formData.get("key");
  const file = formData.get("file");

  if (typeof key !== "string" || key.length === 0 || !(file instanceof File)) {
    return c.json({ error: "Missing upload key or file" }, 400);
  }

  const targetPath = storageFileForKey(key);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));

  return c.json({ storageUri: storageUriForKey(key) });
});

app.delete("/delete", async (c) => {
  const payload = (await c.req.json()) as { storageUri?: string };
  if (!payload.storageUri) {
    return c.json({ error: "Missing storageUri" }, 400);
  }

  const relativeStoragePath = relativeStoragePathFromUri(payload.storageUri);
  const targetPath = resolveWithinStorage(relativeStoragePath);
  await fs.rm(path.dirname(targetPath), { force: true, recursive: true });

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

app.post("/e2e/jobs/bootstrap", async (c) => {
  return c.json({ jobId: startBootstrapJob() });
});

app.post("/e2e/jobs/deploy", async (c) => {
  const payload = (await c.req.json()) as { phase?: "crash" | "stable" };
  if (payload.phase !== "stable" && payload.phase !== "crash") {
    return c.json({ error: "phase must be stable or crash" }, 400);
  }

  return c.json({ jobId: startDeployJob(payload.phase) });
});

app.get("/e2e/jobs/:jobId", async (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json(job);
});

app.post("/e2e/capture-built-in-bundle-id", async (c) => {
  return c.json(await handleCaptureBuiltInBundleId());
});

app.post("/e2e/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    verificationPending?: boolean;
  };
  if (!payload.bundleId || typeof payload.verificationPending !== "boolean") {
    return c.json({ error: "bundleId and verificationPending are required" }, 400);
  }

  return c.json(
    await handleWaitForMetadata(payload.bundleId, payload.verificationPending),
  );
});

app.post("/e2e/capture-state", async (c) => {
  const payload = (await c.req.json()) as { prefix?: "recovered" | "stable" };
  if (payload.prefix !== "stable" && payload.prefix !== "recovered") {
    return c.json({ error: "prefix must be stable or recovered" }, 400);
  }

  return c.json(await handleCaptureState(payload.prefix));
});

app.post("/e2e/assert-metadata-active", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleAssertMetadataActive(payload.bundleId));
});

app.post("/e2e/assert-launch-report", async (c) => {
  const payload = (await c.req.json()) as {
    crashedBundleId?: string;
    optional?: boolean;
    status?: string;
  };
  if (!payload.status) {
    return c.json({ error: "status is required" }, 400);
  }

  return c.json(
    await handleAssertLaunchReport({
      crashedBundleId: payload.crashedBundleId,
      optional: payload.optional ?? false,
      status: payload.status,
    }),
  );
});

app.post("/e2e/assert-crash-history", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleAssertCrashHistory(payload.bundleId));
});

app.post("/e2e/write-summary", async (c) => {
  return c.json(await handleWriteSummary());
});

app.post("/e2e/cleanup", async (c) => {
  return c.json(await handleCleanup());
});

export default app;

import { Hono } from "hono";
import { hotUpdater } from "./db.js";

const app = new Hono();
const hotUpdaterStoreTraces: HotUpdaterStoreTrace[] = [];

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

// Mount Hot Updater handler for all /hot-updater/* routes
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

export default app;

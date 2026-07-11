import { once } from "node:events";

import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  kyselyAdapter,
  type HotUpdaterKyselyDatabase,
} from "./adapters/kysely";
import { createMigrator } from "./db";
import {
  createHotUpdater,
  type HandlerBundleEventsOptions,
  type RuntimeHotUpdaterAPI,
} from "./index";

const retentionMs = 86_400_000;
const database = new PGlite();
const kysely = new Kysely<HotUpdaterKyselyDatabase>({
  dialect: new PGliteDialect(database),
});
const app = new Hono();

let activeHandler: RuntimeHotUpdaterAPI["handler"] = async () =>
  new Response(null, { status: 503 });
let eventUrl = "";
let httpServer: ReturnType<typeof serve> | undefined;

app.all("*", (context) => activeHandler(context.req.raw));

const createEventBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): string =>
  JSON.stringify({
    activeBundleId: "00000000-0000-0000-0000-000000000001",
    appVersion: "1.0.0",
    channel: "production",
    cohort: "730",
    defaultChannel: "production",
    fingerprintHash: "fingerprint-hash",
    installId: "install-1",
    isChannelSwitched: false,
    platform: "ios",
    sdkVersion: "0.31.0",
    status: "STABLE",
    ...overrides,
  });

const createApi = (bundleEvents?: HandlerBundleEventsOptions) =>
  createHotUpdater({
    basePath: "/api",
    database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
    ...(bundleEvents ? { bundleEvents } : {}),
  });

const useApi = (bundleEvents?: HandlerBundleEventsOptions) => {
  const api = createApi(bundleEvents);
  activeHandler = api.handler;
  return api;
};

const postEvent = (
  eventId?: string,
  body: string = createEventBody(),
): Promise<Response> =>
  fetch(eventUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(eventId ? { "Hot-Updater-Event-ID": eventId } : {}),
    },
    body,
  });

const createUUIDv7At = (timestamp: number, tail: string): string => {
  const timestampHex = timestamp.toString(16).padStart(12, "0");
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(
    8,
  )}-7000-8000-${tail.padStart(12, "0")}`;
};

const listEventIds = async (): Promise<readonly string[]> => {
  const rows = await kysely
    .selectFrom("bundle_events")
    .select("id")
    .orderBy("id", "asc")
    .execute();
  return rows.map(({ id }) => id);
};

beforeAll(async () => {
  const migrationApi = createApi();
  const migration = await createMigrator(migrationApi).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await migration.execute();

  const server = serve({ fetch: app.fetch, port: 0 });
  httpServer = server;
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve bundle event integration server port");
  }
  eventUrl = `http://127.0.0.1:${address.port}/api/bundle-events/app-ready`;
});

afterEach(async () => {
  await database.exec("DELETE FROM bundle_events");
  useApi();
});

afterAll(async () => {
  const server = httpServer;
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  } finally {
    httpServer = undefined;
    try {
      await kysely.destroy();
    } finally {
      await database.close();
    }
  }
});

describe("bundle event HTTP persistence boundary", () => {
  it("keeps telemetry disabled by default", async () => {
    // Given
    useApi();

    // When
    const response = await postEvent();

    // Then
    expect(response.status).toBe(404);
    await expect(listEventIds()).resolves.toEqual([]);
  });

  it("returns the deployment policy response without committing", async () => {
    // Given
    useApi({
      policy: () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        }),
    });

    // When
    const response = await postEvent();

    // Then
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(listEventIds()).resolves.toEqual([]);
  });

  it("commits one row for retried requests with the same event ID", async () => {
    // Given
    useApi({});
    const eventId = createUUIDv7At(Date.now() - 1_000, "1");

    // When
    const [firstResponse, retryResponse] = await Promise.all([
      postEvent(eventId),
      postEvent(eventId),
    ]);

    // Then
    expect(firstResponse.status).toBe(201);
    expect(retryResponse.status).toBe(201);
    await expect(listEventIds()).resolves.toEqual([eventId]);
  });

  it("rejects an oversized streaming body before committing", async () => {
    // Given
    useApi({ maxBodyBytes: 256 });
    const bytes = new TextEncoder().encode(
      createEventBody({ userId: "streamed-user".repeat(100) }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 64) {
          controller.enqueue(bytes.slice(offset, offset + 64));
        }
        controller.close();
      },
    });
    const requestInit: RequestInit & { readonly duplex: "half" } = {
      body,
      duplex: "half",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    };
    const request = new Request(eventUrl, requestInit);
    expect(request.headers.get("Content-Length")).toBeNull();

    // When
    const response = await fetch(request);

    // Then
    expect(response.status).toBe(413);
    await expect(listEventIds()).resolves.toEqual([]);
  });

  it("deletes expired rows before committing the current event", async () => {
    // Given
    const now = Date.now();
    const expiredEventId = createUUIDv7At(now - 2 * retentionMs, "1");
    const currentEventId = createUUIDv7At(now - 1_000, "2");
    useApi({});
    const seedResponse = await postEvent(expiredEventId);
    expect(seedResponse.status).toBe(201);
    useApi({ retention: { maxAgeMs: retentionMs } });

    // When
    const response = await postEvent(currentEventId);

    // Then
    expect(response.status).toBe(201);
    await expect(listEventIds()).resolves.toEqual([currentEventId]);
  });
});

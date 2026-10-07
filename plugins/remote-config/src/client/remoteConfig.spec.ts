import {
  type ClientPluginTestRequest,
  type ClientPluginTestStorage,
  createTestStorage,
  setupClientPlugin,
} from "@hot-updater/test-utils/react-native";
import { beforeEach, describe, expect, it } from "vitest";

import { remoteConfig, type RemoteConfigOptions } from "./index";

const HOUR_MS = 3_600_000;

let storage: ClientPluginTestStorage;
let requests: ClientPluginTestRequest[];
let responses: (() => Response)[];
let clock: number;
let channel: string;

const values = (
  body: { version: number; values: Record<string, string> },
  etag = `"v${body.version}"`,
) =>
  Response.json(body, {
    headers: { etag, "cache-control": "public, max-age=0, s-maxage=5" },
  });

/** Starts a JavaScript runtime with the plugin on the test's device. */
const launch = <const T extends Record<string, string | number | boolean>>(
  options: RemoteConfigOptions<T> = {},
) => {
  const config = remoteConfig(options);
  const runtime = setupClientPlugin(config, {
    baseURL: "https://updates.example.com/hot-updater",
    requestHeaders: { "x-api-key": "client-key" },
    respond: (request) => {
      requests.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error("No response queued");
      return next();
    },
    storage,
    platform: "ios",
    appVersion: "2.1.0",
    channel: () => channel,
    cohort: "42",
    fingerprintHash: "fp",
    now: () => clock,
  });
  return { config, runtime };
};

beforeEach(() => {
  storage = createTestStorage();
  requests = [];
  responses = [];
  clock = Date.UTC(2026, 9, 7);
  channel = "production";
});

describe("remoteConfig() client plugin", () => {
  it("reads the in-app defaults synchronously, before and after init, until values are activated", () => {
    const config = remoteConfig({
      defaults: { welcome: "Hi", max_items: 20, dark_mode: true },
    });
    expect(config.getString("welcome")).toBe("Hi");
    expect(config.getNumber("max_items")).toBe(20);
    expect(config.getBoolean("dark_mode")).toBe(true);
    expect(config.getValue("welcome").getSource()).toBe("default");

    const missing = config.getValue("unknown");
    expect(missing.getSource()).toBe("static");
    expect([
      missing.asString(),
      missing.asNumber(),
      missing.asBoolean(),
    ]).toEqual(["", 0, false]);
    expect(config.lastFetchStatus).toBe("no-fetch-yet");
    expect(config.fetchTimeMillis).toBe(-1);
    expect(config.activeVersion).toBe(0);
  });

  it("fetches from the init baseURL with its headers and the device's context", async () => {
    const { config } = launch();
    responses.push(() => values({ version: 3, values: { welcome: "Hey" } }));

    await config.fetch();

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.method).toBe("GET");
    expect(request!.url).toBe(
      "https://updates.example.com/hot-updater/remote-config?platform=ios&appVersion=2.1.0&channel=production&cohort=42&fingerprintHash=fp",
    );
    expect(request!.headers["x-api-key"]).toBe("client-key");
    expect(config.lastFetchStatus).toBe("success");
    expect(config.fetchTimeMillis).toBe(clock);
  });

  it("builds its request without the URL APIs React Native lacks", async () => {
    // React Native's URLSearchParams throws on everything but append.
    const original = globalThis.URLSearchParams;
    globalThis.URLSearchParams = class {
      constructor() {
        throw new Error("URLSearchParams is not implemented");
      }
    } as unknown as typeof URLSearchParams;
    try {
      channel = "beta & qa";
      const { config } = launch();
      responses.push(() => values({ version: 1, values: {} }));
      await config.fetch();
    } finally {
      globalThis.URLSearchParams = original;
    }
    expect(requests[0]!.url).toContain("channel=beta%20%26%20qa&cohort=42");
  });

  it("keeps fetched values for activate, which makes them the synchronous reads", async () => {
    const { config } = launch({ defaults: { welcome: "Hi", limit: 5 } });
    const changes: number[] = [];
    config.subscribe(() => changes.push(config.activeVersion));
    responses.push(() =>
      values({ version: 2, values: { welcome: "Hey", flag: "on" } }),
    );

    await config.fetch();
    expect(config.getString("welcome")).toBe("Hi");

    expect(await config.activate()).toBe(true);
    expect(config.getString("welcome")).toBe("Hey");
    expect(config.getValue("welcome").getSource()).toBe("remote");
    expect(config.getBoolean("flag")).toBe(true);
    expect(config.getNumber("limit")).toBe(5);
    expect(config.activeVersion).toBe(2);
    expect(Object.keys(config.getAll()).sort()).toEqual([
      "flag",
      "limit",
      "welcome",
    ]);
    expect(changes).toEqual([2]);
    // Nothing new to activate.
    expect(await config.activate()).toBe(false);
  });

  it("returns the same getAll object until the values change, for useSyncExternalStore", async () => {
    const { config } = launch({ defaults: { welcome: "Hi" } });
    const before = config.getAll();
    expect(config.getAll()).toBe(before);
    responses.push(() => values({ version: 1, values: { welcome: "Hey" } }));
    await config.fetchAndActivate();
    const after = config.getAll();
    expect(after).not.toBe(before);
    expect(config.getAll()).toBe(after);
    expect(after.welcome!.asString()).toBe("Hey");
  });

  it("reads the values activated at an earlier launch synchronously right after setup", async () => {
    const first = launch({ defaults: { welcome: "Hi" } });
    responses.push(() => values({ version: 4, values: { welcome: "Hey" } }));
    await first.config.fetchAndActivate();

    const relaunch = remoteConfig({ defaults: { welcome: "Hi" } });
    expect(relaunch.getString("welcome")).toBe("Hi");
    const notified: string[] = [];
    relaunch.subscribe(() => notified.push(relaunch.getString("welcome")));
    setupClientPlugin(relaunch, { storage, now: () => clock });

    expect(relaunch.getString("welcome")).toBe("Hey");
    expect(relaunch.activeVersion).toBe(4);
    expect(relaunch.lastFetchStatus).toBe("success");
    expect(relaunch.fetchTimeMillis).toBe(clock);
    expect(notified).toEqual(["Hey"]);
  });

  it("stages a fetch for the next launch without changing what the app reads now", async () => {
    const first = launch({ defaults: { welcome: "Hi" } });
    responses.push(() => values({ version: 1, values: { welcome: "Hey" } }));
    await first.config.fetch();
    expect(first.config.getString("welcome")).toBe("Hi");

    const { config } = launch({ defaults: { welcome: "Hi" } });
    expect(config.getString("welcome")).toBe("Hi");
    expect(await config.activate()).toBe(true);
    expect(config.getString("welcome")).toBe("Hey");
  });

  it("skips the server within the minimum fetch interval, unless the device's context changed", async () => {
    const { config } = launch({ minimumFetchIntervalMs: HOUR_MS });
    responses.push(() => values({ version: 1, values: { a: "1" } }));
    await config.fetch();

    clock += HOUR_MS - 1;
    await config.fetch();
    expect(requests).toHaveLength(1);

    channel = "beta";
    responses.push(() => values({ version: 1, values: { a: "beta" } }));
    await config.fetch();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toContain("channel=beta");

    clock += HOUR_MS;
    responses.push(() => values({ version: 1, values: { a: "beta" } }));
    await config.fetch();
    expect(requests).toHaveLength(3);
  });

  it("waits 12 hours between fetches by default", async () => {
    const { config } = launch();
    responses.push(() => values({ version: 1, values: {} }));
    await config.fetch();
    clock += 12 * HOUR_MS - 1;
    await config.fetch();
    expect(requests).toHaveLength(1);
    clock += 1;
    responses.push(() => values({ version: 1, values: {} }));
    await config.fetch();
    expect(requests).toHaveLength(2);
  });

  it("revalidates with the fetched ETag and keeps the values on a 304", async () => {
    const { config } = launch({ minimumFetchIntervalMs: 0 });
    responses.push(() => values({ version: 5, values: { a: "x" } }, '"abc"'));
    await config.fetchAndActivate();

    clock += 1_000;
    responses.push(() => new Response(null, { status: 304 }));
    expect(await config.fetchAndActivate()).toBe(false);
    expect(requests[1]!.headers["if-none-match"]).toBe('"abc"');
    expect(config.getString("a")).toBe("x");
    expect(config.fetchTimeMillis).toBe(clock);
  });

  it("shares one request between concurrent fetches", async () => {
    const { config } = launch({ minimumFetchIntervalMs: 0 });
    responses.push(() => values({ version: 1, values: {} }));
    await Promise.all([
      config.fetch(),
      config.fetch(),
      config.fetchAndActivate(),
    ]);
    expect(requests).toHaveLength(1);
  });

  it("rejects failed fetches, records the status, and keeps the active values", async () => {
    const { config } = launch({
      defaults: { welcome: "Hi" },
      minimumFetchIntervalMs: 0,
    });
    responses.push(() => values({ version: 1, values: { welcome: "Hey" } }));
    await config.fetchAndActivate();

    responses.push(() => new Response(null, { status: 404 }));
    await expect(config.fetch()).rejects.toThrow(
      "runs without the remoteConfig() plugin",
    );
    expect(config.lastFetchStatus).toBe("failure");

    responses.push(() => new Response(null, { status: 429 }));
    await expect(config.fetch()).rejects.toThrow("HTTP 429");
    expect(config.lastFetchStatus).toBe("throttle");

    responses.push(() => {
      throw new TypeError("Network request failed");
    });
    await expect(config.fetch()).rejects.toThrow("could not be fetched");

    responses.push(() => Response.json({ version: "1" }));
    await expect(config.fetch()).rejects.toThrow("not Remote Config values");

    expect(config.getString("welcome")).toBe("Hey");
  });

  it("fetches only once HotUpdater.init or wrap set the plugin up", async () => {
    const config = remoteConfig();
    await expect(config.fetch()).rejects.toThrow("only after HotUpdater.init");
    expect(await config.activate()).toBe(false);
  });

  it("refuses a negative minimum fetch interval", () => {
    expect(() => remoteConfig({ minimumFetchIntervalMs: -1 })).toThrow(
      "minimumFetchIntervalMs",
    );
  });

  it("ignores stored values it cannot read", () => {
    storage.set("remoteConfig", "active", "{not json");
    storage.set("remoteConfig", "fetched", JSON.stringify({ version: 1 }));
    const { config } = launch({ defaults: { welcome: "Hi" } });
    expect(config.getString("welcome")).toBe("Hi");
    expect(config.lastFetchStatus).toBe("no-fetch-yet");
  });
});

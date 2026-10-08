import {
  type ClientPluginTestRequest,
  type ClientPluginTestStorage,
  createTestStorage,
  setupClientPlugin,
  setupClientPlugins,
} from "@hot-updater/test-utils/react-native";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  remoteConfig,
  type RemoteConfigDefaults,
  type RemoteConfigOptions,
  type RemoteConfigValue,
} from "./index";

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
  const runtime = setupClientPlugin(remoteConfig(options), {
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
  // What `hotUpdater.remoteConfig` is on the instance init returns.
  return { config: runtime.api, runtime };
};

beforeEach(() => {
  storage = createTestStorage();
  requests = [];
  responses = [];
  clock = Date.UTC(2026, 9, 7);
  channel = "production";
});

describe("remoteConfig() client plugin", () => {
  it("reads the in-app defaults synchronously after init, until values are activated", () => {
    const { config } = launch({
      defaults: { welcome: "Hi", max_items: 20, dark_mode: true },
    });
    expect(config.getString("welcome")).toBe("Hi");
    expect(config.getNumber("max_items")).toBe(20);
    expect(config.getBoolean("dark_mode")).toBe(true);
    expect(config.getValue("welcome").getSource()).toBe("default");
    expect(config.lastFetchStatus).toBe("no-fetch-yet");
    expect(config.fetchedAtMs).toBeNull();
    expect(config.activeVersion).toBe(0);
  });

  it("reads null for a key neither the active values nor the defaults have", () => {
    const { config } = launch({ defaults: { welcome: "Hi" } });
    expect(config.getValue("unknown")).toBeNull();
    expect(config.getString("unknown")).toBeNull();
    expect(config.getNumber("unknown")).toBeNull();
    expect(config.getBoolean("unknown")).toBeNull();
  });

  it("reads the active remote value over the default, and the default again once the template drops the key", async () => {
    const { config } = launch({
      defaults: { welcome: "Hi" },
      minimumFetchIntervalMs: 0,
    });
    responses.push(() =>
      values({ version: 1, values: { welcome: "Hey", promo: "50%" } }),
    );
    await config.fetch();
    await config.activate();
    expect(config.getString("welcome")).toBe("Hey");
    expect(config.getValue("welcome").getSource()).toBe("remote");
    expect(config.getString("promo")).toBe("50%");

    // Version 2 leaves both keys to the app.
    responses.push(() => values({ version: 2, values: {} }));
    await config.fetch();
    await config.activate();
    expect(config.getString("welcome")).toBe("Hi");
    expect(config.getValue("welcome").getSource()).toBe("default");
    expect(config.getString("promo")).toBeNull();
  });

  it("keeps false, 0, and empty text as values, from the defaults and from the server", async () => {
    const { config } = launch({
      defaults: { flag: false, count: 0, label: "" },
      minimumFetchIntervalMs: 0,
    });
    expect([
      config.getBoolean("flag"),
      config.getNumber("count"),
      config.getString("label"),
    ]).toEqual([false, 0, ""]);
    expect(config.getValue("label").getSource()).toBe("default");

    responses.push(() =>
      values({
        version: 1,
        values: { remoteFlag: "false", remoteCount: "0", remoteLabel: "" },
      }),
    );
    await config.fetch();
    await config.activate();
    expect([
      config.getBoolean("remoteFlag"),
      config.getNumber("remoteCount"),
      config.getString("remoteLabel"),
    ]).toEqual([false, 0, ""]);
    expect(config.getValue("remoteLabel")?.getSource()).toBe("remote");
  });

  it("types a defaults key's reads as non-null, and any other key's as nullable", () => {
    const { config } = launch({
      defaults: { welcome: "Hi", count: 1, on: true },
    });
    expectTypeOf(config.getString("welcome")).toEqualTypeOf<string>();
    expectTypeOf(config.getNumber("count")).toEqualTypeOf<number>();
    expectTypeOf(config.getBoolean("on")).toEqualTypeOf<boolean>();
    expectTypeOf(config.getString("other")).toEqualTypeOf<string | null>();
    expectTypeOf(
      config.getValue("other"),
    ).toEqualTypeOf<RemoteConfigValue | null>();

    const key: string = "welcome";
    expectTypeOf(config.getString(key)).toEqualTypeOf<string | null>();

    // remoteConfig() without defaults declares no key.
    const bare = setupClientPlugin(remoteConfig(), { storage }).api;
    expectTypeOf(bare.getString("welcome")).toEqualTypeOf<string | null>();
    expect(bare.getString("welcome")).toBeNull();

    // Defaults typed as a map of any string declare no key either.
    const defaults: RemoteConfigDefaults = { welcome: "Hi" };
    const widened = setupClientPlugin(remoteConfig({ defaults }), {
      storage,
    }).api;
    expectTypeOf(widened.getString("welcome")).toEqualTypeOf<string | null>();
    expectTypeOf(widened.getNumber("missing")).toEqualTypeOf<number | null>();
    expect(widened.getString("welcome")).toBe("Hi");
    expect(widened.getString("missing")).toBeNull();
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
    expect(config.fetchedAtMs).toBe(clock);
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
    await config.fetch();
    await config.activate();
    const after = config.getAll();
    expect(after).not.toBe(before);
    expect(config.getAll()).toBe(after);
    expect(after.welcome!.asString()).toBe("Hey");
  });

  it("reads the values activated at an earlier launch synchronously right after setup", async () => {
    const first = launch({ defaults: { welcome: "Hi" } });
    responses.push(() => values({ version: 4, values: { welcome: "Hey" } }));
    await first.config.fetch();
    await first.config.activate();

    const relaunch = setupClientPlugin(
      remoteConfig({ defaults: { welcome: "Hi" } }),
      { storage, now: () => clock },
    ).api;

    expect(relaunch.getString("welcome")).toBe("Hey");
    expect(relaunch.activeVersion).toBe(4);
    expect(relaunch.lastFetchStatus).toBe("success");
    expect(relaunch.fetchedAtMs).toBe(clock);
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
    await config.fetch();
    await config.activate();

    clock += 1_000;
    responses.push(() => new Response(null, { status: 304 }));
    await config.fetch();
    expect(await config.activate()).toBe(false);
    expect(requests[1]!.headers["if-none-match"]).toBe('"abc"');
    expect(config.getString("a")).toBe("x");
    expect(config.fetchedAtMs).toBe(clock);
  });

  it("asks the server within the interval when a fetch is forced", async () => {
    const { config } = launch();
    responses.push(() => values({ version: 1, values: { a: "x" } }, '"v1"'));
    await config.fetch();
    clock += HOUR_MS;
    await config.fetch();
    expect(requests).toHaveLength(1);

    responses.push(() => new Response(null, { status: 304 }));
    await config.fetch({ force: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers["if-none-match"]).toBe('"v1"');
    expect(config.fetchedAtMs).toBe(clock);

    // A forced fetch joins one already on its way, which is a request too.
    responses.push(() => values({ version: 2, values: { a: "y" } }));
    await Promise.all([
      config.fetch({ force: true }),
      config.fetch({ force: true }),
    ]);
    expect(requests).toHaveLength(3);
    await config.activate();
    expect(config.getString("a")).toBe("y");
  });

  it("retries at the next fetch after a failure, which does not start the interval", async () => {
    const { config } = launch();
    responses.push(() => values({ version: 1, values: {} }));
    await config.fetch();
    clock += 12 * HOUR_MS;
    responses.push(() => new Response(null, { status: 503 }));
    await expect(config.fetch()).rejects.toThrow("HTTP 503");
    responses.push(() => values({ version: 2, values: {} }));
    await config.fetch();
    expect(requests).toHaveLength(3);
    expect(config.lastFetchStatus).toBe("success");
    expect(config.fetchedAtMs).toBe(clock);
  });

  it("fetches, then activates, in one call", async () => {
    const { config } = launch({ defaults: { welcome: "Hi" } });
    responses.push(() => values({ version: 1, values: { welcome: "Hey" } }));
    await expect(config.fetchAndActivate()).resolves.toBe(true);
    expect(config.getString("welcome")).toBe("Hey");
    expect(config.activeVersion).toBe(1);

    // Within the interval: no request, and nothing new to activate.
    await expect(config.fetchAndActivate()).resolves.toBe(false);
    expect(requests).toHaveLength(1);

    clock += HOUR_MS;
    responses.push(() => values({ version: 2, values: { welcome: "Yo" } }));
    await expect(config.fetchAndActivate({ force: true })).resolves.toBe(true);
    expect(config.getString("welcome")).toBe("Yo");

    // A failed fetch rejects, and the active values stay.
    responses.push(() => new Response(null, { status: 500 }));
    await expect(config.fetchAndActivate({ force: true })).rejects.toThrow(
      "HTTP 500",
    );
    expect(config.getString("welcome")).toBe("Yo");
  });

  it("shares one request between concurrent fetches", async () => {
    const { config } = launch({ minimumFetchIntervalMs: 0 });
    responses.push(() => values({ version: 1, values: {} }));
    await Promise.all([
      config.fetch(),
      config.fetch(),
      config.fetch().then(() => config.activate()),
    ]);
    expect(requests).toHaveLength(1);
  });

  it("rejects failed fetches, records the status, and keeps the active values", async () => {
    const { config } = launch({
      defaults: { welcome: "Hi" },
      minimumFetchIntervalMs: 0,
    });
    responses.push(() => values({ version: 1, values: { welcome: "Hey" } }));
    await config.fetch();
    await config.activate();

    responses.push(() => new Response(null, { status: 404 }));
    await expect(config.fetch()).rejects.toThrow(
      "runs without the remoteConfig() plugin",
    );
    expect(config.lastFetchStatus).toBe("failure");

    responses.push(() => new Response(null, { status: 429 }));
    await expect(config.fetch()).rejects.toThrow("HTTP 429");
    expect(config.lastFetchStatus).toBe("failure");

    responses.push(() => {
      throw new TypeError("Network request failed");
    });
    await expect(config.fetch()).rejects.toThrow("could not be fetched");

    responses.push(() => Response.json({ version: "1" }));
    await expect(config.fetch()).rejects.toThrow("not Remote Config values");

    expect(config.getString("welcome")).toBe("Hey");
  });

  it("has its API only on the instance init returns, not on the plugin", () => {
    const plugin = remoteConfig({ defaults: { welcome: "Hi" } });
    expect(Object.keys(plugin).toSorted()).toEqual(["id", "setup"]);
    expect(setupClientPlugin(plugin).api.getString("welcome")).toBe("Hi");
    // Among other plugins, it is the API under the plugin's id.
    const runtime = setupClientPlugins([plugin]);
    expect(runtime.apis.remoteConfig.getString("welcome")).toBe("Hi");
  });

  it("refuses a negative minimum fetch interval", () => {
    expect(() => remoteConfig({ minimumFetchIntervalMs: -1 })).toThrow(
      "minimumFetchIntervalMs",
    );
  });

  it("reads keys that Object.prototype also has as the template's or the defaults'", async () => {
    const { config } = launch({ defaults: { constructor: "in-app" } });
    expect(config.getValue("toString")).toBeNull();
    expect(config.getBoolean("valueOf")).toBeNull();
    expect(config.getValue("constructor").getSource()).toBe("default");

    responses.push(() =>
      values({
        version: 1,
        values: { constructor: "remote", hasOwnProperty: "yes" },
      }),
    );
    await config.fetch();
    await config.activate();
    expect(config.getString("constructor")).toBe("remote");
    expect(config.getBoolean("hasOwnProperty")).toBe(true);
    expect(config.getValue("toString")).toBeNull();
  });

  it("ignores stored values it cannot read", () => {
    storage.set("remoteConfig", "active", "{not json");
    storage.set("remoteConfig", "fetched", JSON.stringify({ version: 1 }));
    storage.set("remoteConfig", "lastFetchStatus", "throttle");
    const { config } = launch({ defaults: { welcome: "Hi" } });
    expect(config.getString("welcome")).toBe("Hi");
    expect(config.lastFetchStatus).toBe("no-fetch-yet");
    expect(config.fetchedAtMs).toBeNull();
  });
});

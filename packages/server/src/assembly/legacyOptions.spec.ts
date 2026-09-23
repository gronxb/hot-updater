import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { createLegacyDatabasePlugin } from "../database/legacyFacade";
import { resetDeprecationWarnings } from "../deprecations";
import { apiKeys } from "../plugins/api-keys";
import { insights } from "../plugins/insights";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const CATALOG =
  "https://updates.example.com/release-catalogs/app-version/ios/production/1.0.0";

const database = () =>
  createLegacyDatabasePlugin({
    name: "memory",
    adapter: createMemoryAdapter(),
  });

let warn: MockInstance<typeof console.warn>;
const warnings = () => warn.mock.calls.map(([message]) => String(message));

beforeEach(() => {
  resetDeprecationWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("legacy createHotUpdater options", () => {
  it("serves Insights through the database plugin without plugins, warning once", async () => {
    const first = createHotUpdater({
      database: database(),
      clientAccess: "public",
    });
    createHotUpdater({ database: database(), clientAccess: "public" });

    expect(warnings()).toEqual([
      expect.stringContaining(
        "Without plugins, createHotUpdater serves Insights through the database plugin, which is deprecated and stops in 1.0.",
      ),
    ]);
    const events = await first.handlers.client(
      new Request("https://updates.example.com/events", {
        method: "POST",
        body: "{",
      }),
    );
    expect(events.status).toBe(400);
    expect(events.headers.get("x-hot-updater-insights")).toBeNull();
  });

  it('reads clientAccess: { type: "public" } as "public", with a warning', async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [],
      clientAccess: { type: "public" },
    });

    expect(warnings()).toEqual(
      [
        'clientAccess: { type: "public" } is deprecated and stops working in 1.0. Use clientAccess: "public".',
      ].map((message) => `[hot-updater] ${message}`),
    );
    const events = await hotUpdater.handlers.client(
      new Request("https://updates.example.com/events", { method: "POST" }),
    );
    expect(events.status).toBe(204);
    expect(events.headers.get("x-hot-updater-insights")).toBe("disabled");
  });

  it("keeps a legacy API-key policy on the database plugin without plugins", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      clientAccess: { type: "api-key" },
    });

    expect(warnings()).toContainEqual(
      expect.stringContaining(
        'clientAccess: { type: "api-key" } is deprecated and stops working in 1.0. Remove it and add apiKeys() from @hot-updater/server/plugins/api-keys to plugins',
      ),
    );
    expect(
      (await hotUpdater.handlers.client(new Request(CATALOG))).status,
    ).toBe(401);
    await hotUpdater.apiKeys.create({ name: "App" });
  });

  it("turns a legacy API-key policy into apiKeys() when plugins are given", async () => {
    const hotUpdater = createHotUpdater({
      database: database(),
      plugins: [insights()],
      clientAccess: { type: "api-key", headerName: "X-Key" },
    });
    const keys = (
      hotUpdater.api as unknown as {
        readonly apiKeys: ReturnType<ReturnType<typeof apiKeys>["init"]>["api"];
      }
    ).apiKeys;
    await keys.register({ apiKey: API_KEY, name: "App" });
    const events = (headers: Record<string, string>) =>
      hotUpdater.handlers.client(
        new Request("https://updates.example.com/events", {
          method: "POST",
          headers,
          body: "{",
        }),
      );

    expect(warnings()).toEqual([
      expect.stringContaining(
        'Remove it and add apiKeys({ headerName: "x-key" }) from @hot-updater/server/plugins/api-keys to plugins',
      ),
    ]);
    expect((await events({})).status).toBe(401);
    expect((await events({ "x-key": API_KEY })).status).toBe(400);
    await expect(hotUpdater.apiKeys.list()).resolves.toMatchObject([
      { name: "App" },
    ]);
  });

  it("refuses a legacy API-key policy beside a plugin that provides clientAuth", () => {
    expect(() =>
      createHotUpdater({
        database: database(),
        plugins: [apiKeys()],
        clientAccess: { type: "api-key" },
      } as never),
    ).toThrow('Plugin "apiKeys" provides clientAuth, so remove clientAccess.');
  });
});

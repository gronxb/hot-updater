import { remoteConfig as remoteConfigClient } from "@hot-updater/plugin-remote-config/client";
import { setupClientPlugin } from "@hot-updater/test-utils/react-native";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../../index";
import { createRuntimeDatabase } from "../../runtime.testFixtures";
import { apiKeys } from "../api-keys";
import { remoteConfig, type RemoteConfigTemplate } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const BASE_URL = "https://updates.example.com/hot-updater";

const template: RemoteConfigTemplate = {
  conditions: [
    {
      name: "Android beta",
      rules: [
        { type: "platform", platforms: ["android"] },
        { type: "channel", channels: ["beta"] },
      ],
    },
  ],
  parameters: {
    welcome: {
      valueType: "STRING",
      defaultValue: { value: "Welcome" },
      conditionalValues: { "Android beta": { value: "Welcome, tester" } },
    },
    max_items: {
      valueType: "NUMBER",
      defaultValue: { useInAppDefault: true },
    },
  },
};

/** Where the handlers see a request: the framework strips BASE_URL's path. */
const mounted = (path: string) => `https://updates.example.com${path}`;

/** A server with API keys and Remote Config, and its handlers mounted under BASE_URL. */
const start = async () => {
  const hotUpdater = createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [apiKeys(), remoteConfig()],
  });
  await hotUpdater.api.apiKeys.register({ apiKey: API_KEY, name: "App" });
  const route =
    (handler: (request: Request) => Promise<Response>) =>
    (path: string, init: RequestInit = {}) =>
      handler(new Request(mounted(path), init));
  return {
    hotUpdater,
    client: route(hotUpdater.handlers.client),
    admin: route(hotUpdater.handlers.admin),
  };
};

describe("createHotUpdater with remoteConfig()", () => {
  it("serves the app's client plugin through the baseURL and headers HotUpdater.init configures", async () => {
    const { hotUpdater } = await start();
    await hotUpdater.api.remoteConfig.publish({ template, baseVersion: 0 });

    const run = (device: { platform: "ios" | "android"; channel: string }) => {
      const config = remoteConfigClient({ defaults: { max_items: 10 } });
      setupClientPlugin(config, {
        baseURL: BASE_URL,
        requestHeaders: { "x-api-key": API_KEY },
        respond: (request) =>
          hotUpdater.handlers.client(
            new Request(mounted(request.path), {
              method: request.method,
              headers: request.headers,
            }),
          ),
        ...device,
      });
      return config;
    };

    const ios = run({ platform: "ios", channel: "beta" });
    expect(await ios.fetchAndActivate()).toBe(true);
    expect(ios.getString("welcome")).toBe("Welcome");
    expect(ios.getValue("max_items").getSource()).toBe("default");
    expect(ios.getNumber("max_items")).toBe(10);
    expect(ios.activeVersion).toBe(1);

    const android = run({ platform: "android", channel: "beta" });
    await android.fetchAndActivate();
    expect(android.getString("welcome")).toBe("Welcome, tester");
  });

  it("puts GET /remote-config behind the client-route policy, cacheable per key and revalidated by ETag", async () => {
    const { hotUpdater, client } = await start();
    await hotUpdater.api.remoteConfig.publish({ template, baseVersion: 0 });
    const path = "/remote-config?platform=android&channel=beta&cohort=7";

    expect((await client(path)).status).toBe(401);

    const response = await client(path, { headers: { "x-api-key": API_KEY } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      values: { welcome: "Welcome, tester" },
    });
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=5",
    );
    expect(response.headers.get("vary")).toContain("x-api-key");
    const etag = response.headers.get("etag")!;
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/u);

    const revalidated = await client(path, {
      headers: { "x-api-key": API_KEY, "if-none-match": etag },
    });
    expect(revalidated.status).toBe(304);

    expect(
      (
        await client("/remote-config?platform=web", {
          headers: { "x-api-key": API_KEY },
        })
      ).status,
    ).toBe(400);
  });

  it("publishes, lists, and rolls back templates through the admin routes", async () => {
    const { admin } = await start();
    const put = (body: unknown) =>
      admin("/remote-config/template", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const empty = await admin("/remote-config/template");
    expect(empty.headers.get("cache-control")).toBe("private, no-store");
    expect(await empty.json()).toMatchObject({ version: 0 });

    const published = await put({
      template,
      baseVersion: 0,
      description: "Launch copy",
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      version: 1,
      description: "Launch copy",
      updateType: "PUBLISH",
    });

    const stale = await put({ template, baseVersion: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ currentVersion: 1 });

    const invalid = await put({
      template: { parameters: { x: { valueType: "COLOR" } } },
      baseVersion: 1,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      issues: [{ path: "parameters.x.valueType" }],
    });

    expect((await put({ template: {}, baseVersion: 1 })).status).toBe(200);
    const rollback = await admin("/remote-config/versions/1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 2 }),
    });
    expect(await rollback.json()).toMatchObject({
      version: 3,
      updateType: "ROLLBACK",
      rollbackSource: 1,
    });

    const page = (await (await admin("/remote-config/versions")).json()) as {
      versions: { version: number }[];
    };
    expect(page.versions.map(({ version }) => version)).toEqual([3, 2, 1]);
    expect(
      await (await admin("/remote-config/versions/3")).json(),
    ).toMatchObject({ version: 3, template });
    expect((await admin("/remote-config/versions/9")).status).toBe(404);
    expect((await admin("/remote-config/versions/x")).status).toBe(400);
  });

  it("answers a request it refuses with 400", async () => {
    const { admin } = await start();
    const errorOf = async (response: Response) => ({
      status: response.status,
      body: await response.json(),
    });

    expect(
      await errorOf(
        await admin("/remote-config/template", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ template: {}, baseVersion: -1 }),
        }),
      ),
    ).toEqual({
      status: 400,
      body: { error: "baseVersion must be a non-negative integer." },
    });
    expect(
      await errorOf(await admin("/remote-config/versions?limit=500")),
    ).toMatchObject({ status: 400 });
    expect(
      await errorOf(await admin("/remote-config/versions?cursor=not-a-cursor")),
    ).toMatchObject({ status: 400 });
  });
});

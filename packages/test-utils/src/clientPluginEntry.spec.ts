import { defineClientPlugin } from "@hot-updater/react-native/client-plugin";
import { describe, expect, it } from "vitest";

import { setupClientPlugin } from "./setupClientPlugins";

const bundleId = "0199a0c3-6f6e-7c3a-9a3e-1b2c3d4e5f60";

/**
 * A third-party plugin as the client plugin guide writes one: it imports
 * only `@hot-updater/react-native/client-plugin`, which loads neither React
 * Native nor the native module.
 */
const launchReporter = () =>
  defineClientPlugin({
    id: "acme-launch-reporter",
    setup(context) {
      return {
        async onAppReady(result) {
          context.storage.set("lastStatus", result.status);
          await context.fetch("acme/launches", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: result.status,
              bundleId: context.getBundleId(),
              platform: context.platform,
            }),
          });
        },
      };
    },
  });

describe("@hot-updater/react-native/client-plugin", () => {
  it("runs a plugin that imports only this entry in plain Node", async () => {
    const runtime = setupClientPlugin(launchReporter(), {
      platform: "android",
      bundleId,
      requestHeaders: { "x-api-key": "client-key" },
    });

    runtime.hooks.onAppReady({
      status: "UNCHANGED",
      channel: "production",
      bundleId,
      releaseId: null,
      previousProcessExit: null,
    });
    await runtime.settled();

    expect(runtime.errors).toEqual([]);
    expect(runtime.storage.get("acme-launch-reporter", "lastStatus")).toBe(
      "UNCHANGED",
    );
    expect(
      runtime.requests.map((request) => ({
        method: request.method,
        path: request.path,
        apiKey: request.headers["x-api-key"],
        body: request.json(),
      })),
    ).toEqual([
      {
        method: "POST",
        path: "/acme/launches",
        apiKey: "client-key",
        body: { status: "UNCHANGED", bundleId, platform: "android" },
      },
    ]);
  });
});

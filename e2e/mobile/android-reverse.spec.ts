import { describe, expect, it } from "vitest";

import {
  acquireAndroidReverses,
  planAndroidReverses,
} from "./android-reverse.ts";
import type { MobileContext } from "./context.ts";

const context: MobileContext = {
  runtime: "react-native",
  platform: "android",
  deviceId: "emulator-5562",
  session: "isolated",
  runId: "run",
  headSha: "head",
  profile: "profile",
  resultsDir: "/results",
  appPath: "/app.apk",
  appId: "app",
  scenarioNames: [],
  controlBaseUrl: "http://localhost:3112",
  scenarioTimeoutMs: 1000,
  setupTimeoutMs: 1000,
  cleanupTimeoutMs: 1000,
};
const env = {
  HOT_UPDATER_E2E_APP_BASE_URL: "http://localhost:3007/hot-updater",
  HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT: "3012",
  PORT: "3112",
};

function fakeAdb(initial: [string, string][] = []) {
  const mappings = new Map(initial);
  const calls: string[][] = [];
  return {
    mappings,
    calls,
    execute: async (args: string[]) => {
      expect(args.slice(0, 3)).toEqual(["-s", "emulator-5562", "reverse"]);
      calls.push(args.slice(3));
      const [action, device, host] = args.slice(3);
      if (action === "--list")
        return [...mappings]
          .map(([from, to]) => `emulator-5562 ${from} ${to}`)
          .join("\n");
      if (action === "--no-rebind") {
        if (mappings.has(device)) throw new Error("mapping already exists");
        mappings.set(device, host);
      } else if (action === "--remove") {
        mappings.delete(device);
      } else throw new Error(`Unexpected command: ${action}`);
      return "";
    },
  };
}

describe("owned Android reverse mappings", () => {
  it("resolves the same provider and control ports as the fixture controller", () => {
    expect(planAndroidReverses(env)).toEqual([
      { device: "tcp:3007", host: "tcp:3012" },
      { device: "tcp:3107", host: "tcp:3112" },
    ]);
    expect(
      planAndroidReverses({
        ...env,
        HOT_UPDATER_E2E_APP_BASE_URL: "https://provider.example/hot-updater",
      }),
    ).toEqual([{ device: "tcp:3107", host: "tcp:3112" }]);
  });

  it("refuses a conflict before creating any missing mapping", async () => {
    const adb = fakeAdb([["tcp:3107", "tcp:9999"]]);
    await expect(
      acquireAndroidReverses(context, env, adb.execute),
    ).rejects.toThrow("already mapped");
    expect(adb.calls).toEqual([["--list"]]);
  });

  it("keeps identical preexisting mappings and removes only its own mappings", async () => {
    const adb = fakeAdb([
      ["tcp:3007", "tcp:3012"],
      ["tcp:9000", "tcp:9001"],
    ]);
    const release = await acquireAndroidReverses(context, env, adb.execute);
    expect(adb.mappings.get("tcp:3107")).toBe("tcp:3112");
    await release();
    await release();
    expect([...adb.mappings]).toEqual([
      ["tcp:3007", "tcp:3012"],
      ["tcp:9000", "tcp:9001"],
    ]);
    expect(adb.calls.filter((args) => args[0] === "--remove")).toEqual([
      ["--remove", "tcp:3107"],
    ]);
  });

  it("does not remove an owned port rebound by another session", async () => {
    const adb = fakeAdb();
    const release = await acquireAndroidReverses(context, env, adb.execute);
    adb.mappings.set("tcp:3007", "tcp:9999");
    await release();
    expect([...adb.mappings]).toEqual([["tcp:3007", "tcp:9999"]]);
  });

  it("releases earlier owned mappings if a competing mapping appears during acquisition", async () => {
    const adb = fakeAdb();
    const execute = async (args: string[]) => {
      if (args[3] === "--no-rebind" && args[4] === "tcp:3107") {
        adb.mappings.set("tcp:3107", "tcp:9999");
      }
      return adb.execute(args);
    };
    await expect(acquireAndroidReverses(context, env, execute)).rejects.toThrow(
      "already exists",
    );
    expect([...adb.mappings]).toEqual([["tcp:3107", "tcp:9999"]]);
  });

  it("rejects provider/control collisions before running adb and skips iOS", async () => {
    const adb = fakeAdb();
    await expect(
      acquireAndroidReverses(
        context,
        { ...env, HOT_UPDATER_E2E_APP_BASE_URL: "http://localhost:3107" },
        adb.execute,
      ),
    ).rejects.toThrow("conflict");
    await (
      await acquireAndroidReverses(
        { ...context, platform: "ios" },
        env,
        adb.execute,
      )
    )();
    expect(adb.calls).toEqual([]);
  });
});

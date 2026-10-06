import { expect, it } from "vitest";

import { runtimeLaunchArguments } from "./attempt.ts";

it("encodes runtime URLs in native launch arguments without breaking URL punctuation", () => {
  const env = {
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
      "http://127.0.0.1:3107/e2e/runtime-config?profile=a=b",
    HOT_UPDATER_E2E_APP_BASE_URL: "http://127.0.0.1:3007/hot-updater",
  };
  expect(runtimeLaunchArguments("ios", env)).toEqual([
    "-HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "-HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
  expect(runtimeLaunchArguments("android", env)).toEqual([
    "--es",
    "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "--es",
    "HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
});

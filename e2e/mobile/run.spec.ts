import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { listScenarioNames } from "../shared/scenarios.ts";
import { parseMobileOptions, runMobile, runSdkChild } from "./run.ts";

describe("mobile wrapper", () => {
  it("selects the shared default manifest and requires an explicit device", () => {
    expect(
      parseMobileOptions(
        ["--platform", "android", "--device", "emulator-5558"],
        {},
      ).scenarios,
    ).toEqual(listScenarioNames());
    expect(() =>
      parseMobileOptions(["--platform", "ios", "--device", "iPhone 16"], {}),
    ).toThrow("UDID");
    expect(() => parseMobileOptions(["--platform", "android"], {})).toThrow(
      "explicitly leased",
    );
  });

  it("preserves bot comma-separated selection and rejects duplicates or unknown tests", () => {
    const names = listScenarioNames().slice(0, 2);
    const args = ["--", "--platform", "android", "--device", "emulator-5558"];
    expect(
      parseMobileOptions(args, { HOT_UPDATER_E2E_SCENARIOS: names.join(",") })
        .scenarios,
    ).toEqual(names);
    expect(() =>
      parseMobileOptions(
        [...args, "--scenario", names[0]!, "--scenario", names[0]!],
        {},
      ),
    ).toThrow("Duplicate scenarios");
    expect(() =>
      parseMobileOptions([...args, "--scenario", "missing"], {}),
    ).toThrow("Unknown scenario");
    expect(() =>
      parseMobileOptions(
        [...args, "--suite", "default", "--scenario", names[0]!],
        {},
      ),
    ).toThrow("either");
  });

  it("dry-runs without checking binaries, Git, or contacting devices and providers", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await runMobile(
          ["--platform", "android", "--device", "nonexistent", "--dry-run"],
          {
            HOT_UPDATER_E2E_ANDROID_BINARY_PATH: "/does/not/exist.apk",
            CONTROL_URL: "http://invalid.invalid",
          },
        ),
      ).toBe(0);
      expect(JSON.parse(output.mock.calls[0]![0]).workers).toBe(1);
    } finally {
      output.mockRestore();
    }
  });

  it("waits for its owned child's cooperative cleanup after cancellation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-wrapper-"));
    const controller = new AbortController();
    const ready = path.join(directory, "ready");
    const done = path.join(directory, "done");
    const script = `const fs = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.argv[2], 'drained'); process.exit(0); }, 75)); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`;
    const child = runSdkChild(
      process.execPath,
      ["-e", script, ready, done],
      process.env,
      controller.signal,
    );
    try {
      for (let i = 0; ; i++) {
        if ((await readFile(ready, "utf8").catch(() => "")) === "ready") break;
        if (i > 100) throw new Error("Child did not become ready");
        await sleep(10);
      }
      controller.abort();
      expect(await child).toBe(0);
      expect(await readFile(done, "utf8")).toBe("drained");
    } finally {
      controller.abort();
      await child;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

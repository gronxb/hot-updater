import { describe, expect, it, vi } from "vitest";

import { runE2e } from "./run.ts";

describe("shared contributor and bot entry", () => {
  it("forwards prepared bot arguments and environment without local preparation", async () => {
    const mobile = vi.fn().mockResolvedValue(17);
    const local = vi.fn();
    const env = {
      HOT_UPDATER_E2E_SCENARIOS: "release-ota-recovery",
      BOT_OWNED: "yes",
    };
    const args = [
      "--platform",
      "android",
      "--prepared",
      "--device",
      "emulator-5554",
      "--run-id",
      "bot-job",
    ];
    await expect(runE2e(args, env, { mobile, local })).resolves.toBe(17);
    expect(mobile).toHaveBeenCalledWith(
      args.filter((arg) => arg !== "--prepared"),
      env,
    );
    expect(local).not.toHaveBeenCalled();
  });

  it("validates a typo in a scenario before any local service starts", async () => {
    const mobile = vi.fn();
    const local = vi.fn();
    await expect(
      runE2e(
        ["--platform", "ios", "--scenario", "does-not-exist"],
        {},
        { mobile, local },
      ),
    ).rejects.toThrow("Unknown scenario");
    expect(local).not.toHaveBeenCalled();
    expect(mobile).not.toHaveBeenCalled();
  });

  it("prints a local plan without selecting or booting any device", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mobile = vi.fn();
    const local = vi.fn();
    try {
      await expect(
        runE2e(
          [
            "--platform",
            "android",
            "--scenario",
            "release-ota-recovery",
            "--dry-run",
          ],
          {},
          { mobile, local },
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        platform: "android",
        profile: "standalone-kysely",
        scenarios: ["release-ota-recovery"],
      });
      expect(local).not.toHaveBeenCalled();
      expect(mobile).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("rejects cloud profiles in local mode instead of touching caller resources", async () => {
    const mobile = vi.fn();
    const local = vi.fn();
    await expect(
      runE2e(
        ["--platform", "android", "--profile", "aws"],
        {},
        { mobile, local },
      ),
    ).rejects.toThrow("Use --prepared");
    expect(local).not.toHaveBeenCalled();
  });

  it("delegates a valid local selection once with the explicit device", async () => {
    const mobile = vi.fn();
    const local = vi.fn().mockResolvedValue(0);
    const args = [
      "--platform",
      "android",
      "--device",
      "emulator-5554",
      "--scenario",
      "release-ota-recovery",
    ];
    await expect(runE2e(args, {}, { mobile, local })).resolves.toBe(0);
    expect(local).toHaveBeenCalledWith(
      args,
      expect.any(String),
      "android",
      "emulator-5554",
      {},
    );
    expect(mobile).not.toHaveBeenCalled();
  });
});

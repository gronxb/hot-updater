import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  privateDaemonEnvironment,
  resolvePinnedAgentDevice,
  startOwnedAgentDeviceDaemon,
  validateDaemonRegistration,
  validateDaemonShutdown,
} from "./agent-device-daemon.ts";

const owner = {
  pid: 123,
  stateDir: "/owned",
  processStartTime: "Sun Oct 4 10:00:00 2026",
};
const registration = {
  ...owner,
  version: "0.21.18",
  transport: "http",
  httpPort: 43123,
  token: "a".repeat(48),
};
const shutdown = {
  success: true,
  data: {
    stopped: true,
    mode: "graceful",
    cleanupConfidence: "known",
    clean: true,
    providerReleases: { status: "completed", released: [], pending: [] },
    claimsOrphaned: [],
    claimsUnattributable: [],
    claimsSuperseded: [],
  },
};

describe("private agent-device daemon", () => {
  it("replaces inherited daemon and runner settings without relocating shared device ownership", () => {
    const env = privateDaemonEnvironment(
      {
        HOME: "/real-home",
        PATH: "/bin",
        HOT_UPDATER_E2E_DEVICE_ID: "leased-device",
        AGENT_DEVICE_STATE_DIR: "/someone-else",
        AGENT_DEVICE_DAEMON_BASE_URL: "http://someone-else",
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: "inherited-secret",
        AGENT_DEVICE_IOS_RUNNER_DETACH: "1",
        AGENT_DEVICE_DAEMON_AUTH_HOOK: "/unrelated-hook.js",
      },
      "/owned",
    );
    expect(env).toEqual({
      HOME: "/real-home",
      PATH: "/bin",
      HOT_UPDATER_E2E_DEVICE_ID: "leased-device",
      AGENT_DEVICE_STATE_DIR: "/owned",
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_IOS_RUNNER_DETACH: "0",
    });
  });

  it("never includes a malformed registration's token in its diagnostic", () => {
    const secret = "private-token-marker-that-must-not-be-reported";
    let caught: unknown;
    try {
      validateDaemonRegistration(`{"token":"${secret}", malformed}`, owner);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("invalid JSON");
    expect(String(caught)).not.toContain(secret);
  });

  it.each([
    { pid: 456 },
    { processStartTime: "recycled PID" },
    { stateDir: "/unowned" },
    { version: "0.21.19" },
    { transport: "socket" },
    { token: "" },
    { httpPort: 0 },
  ])(
    "rejects registration that cannot prove the owned process (%j)",
    (change) => {
      expect(() =>
        validateDaemonRegistration({ ...registration, ...change }, owner),
      ).toThrow("did not match");
    },
  );

  it.each([
    { mode: "forced" },
    { cleanupConfidence: "unknown" },
    { clean: false },
    {
      providerReleases: {
        status: "completed",
        pending: [{ leaseId: "owned" }],
      },
    },
    { claimsOrphaned: [{ deviceId: "owned" }] },
    { claimsUnattributable: [{ deviceId: "ambiguous" }] },
  ])("rejects incomplete cleanup (%j)", (change) => {
    expect(() =>
      validateDaemonShutdown({
        ...shutdown,
        data: { ...shutdown.data, ...change },
      }),
    ).toThrow("complete cleanup");
  });

  it("permits an explicit superseding owner whose device claim must be left alone", () => {
    expect(() =>
      validateDaemonShutdown({
        ...shutdown,
        data: {
          ...shutdown.data,
          claimsSuperseded: [{ deviceId: "another-owner" }],
        },
      }),
    ).not.toThrow();
  });

  it("starts, health-checks and cleanly stops the installed pinned daemon without opening a device", async () => {
    const daemon = await startOwnedAgentDeviceDaemon(
      {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: "/must-not-use-inherited-state",
        AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:1",
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: "must-not-use-inherited-token",
      },
      new AbortController().signal,
    );
    try {
      expect((await fs.stat(daemon.stateDir)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(daemon.stateDir, "daemon.json"))).mode & 0o777,
      ).toBe(0o600);
      expect(daemon.env.AGENT_DEVICE_DAEMON_BASE_URL).toBe(daemon.baseUrl);
      expect(daemon.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN).not.toBe(
        "must-not-use-inherited-token",
      );
      const installation = await resolvePinnedAgentDevice();
      const listed = await promisify(execFile)(
        process.execPath,
        [installation.cli, "session", "list", "--json"],
        { env: daemon.env, timeout: 5000, encoding: "utf8" },
      );
      expect(JSON.parse(listed.stdout)).toMatchObject({
        success: true,
        data: { sessions: [] },
      });
      const response = await fetch(`${daemon.baseUrl}/health`);
      expect(await response.json()).toMatchObject({
        service: "agent-device-daemon",
        version: "0.21.18",
        rpcProtocolVersion: 2,
      });
    } finally {
      await daemon.stop();
    }
    await daemon.stop();
    await expect(fs.stat(daemon.stateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("keeps a second private daemon usable after its peer shuts down", async () => {
    const first = await startOwnedAgentDeviceDaemon(
      process.env,
      new AbortController().signal,
    );
    let second:
      | Awaited<ReturnType<typeof startOwnedAgentDeviceDaemon>>
      | undefined;
    try {
      second = await startOwnedAgentDeviceDaemon(
        process.env,
        new AbortController().signal,
      );
      expect(first.pid).not.toBe(second.pid);
      expect(first.stateDir).not.toBe(second.stateDir);
      expect(first.baseUrl).not.toBe(second.baseUrl);
      const registrationPath = path.join(second.stateDir, "daemon.json");
      const before = JSON.parse(await fs.readFile(registrationPath, "utf8"));
      const healthBefore = await (
        await fetch(`${second.baseUrl}/health`)
      ).json();

      await first.stop();

      await expect(fs.stat(first.stateDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const after = JSON.parse(await fs.readFile(registrationPath, "utf8"));
      expect(after.pid).toBe(before.pid);
      expect(after.processStartTime).toBe(before.processStartTime);
      expect(await (await fetch(`${second.baseUrl}/health`)).json()).toEqual(
        healthBefore,
      );
      const installation = await resolvePinnedAgentDevice();
      const listed = await promisify(execFile)(
        process.execPath,
        [installation.cli, "session", "list", "--json"],
        { env: second.env, timeout: 5000, encoding: "utf8" },
      );
      expect(JSON.parse(listed.stdout)).toMatchObject({
        success: true,
        data: { sessions: [] },
      });
    } finally {
      await Promise.all([first.stop(), second?.stop()]);
    }
    await expect(fs.stat(second!.stateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("cleans its started daemon when cancellation arrives during the health check", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    let baseUrl = "";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce((input, options) => {
        baseUrl = String(input).replace(/\/health$/, "");
        controller.abort(new Error("startup cancelled"));
        return originalFetch(input, options);
      });
    try {
      await expect(
        startOwnedAgentDeviceDaemon(process.env, controller.signal),
      ).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  }, 30_000);

  it("never signals a foreign PID substituted into its registration", async () => {
    const foreign = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(foreign, "spawn");
    const daemon = await startOwnedAgentDeviceDaemon(
      process.env,
      new AbortController().signal,
    );
    try {
      const file = path.join(daemon.stateDir, "daemon.json");
      const metadata = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(
        file,
        JSON.stringify({ ...metadata, pid: foreign.pid }),
      );
      await expect(daemon.stop()).rejects.toThrow("cleanup is uncertain");
      expect(foreign.exitCode).toBeNull();
      expect(foreign.signalCode).toBeNull();
    } finally {
      foreign.kill("SIGTERM");
      await once(foreign, "exit");
      await daemon.stop().catch(() => {});
      await fs.rm(daemon.stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});

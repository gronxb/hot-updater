import {
  loadConfig,
  loadVaultDeployCredentials,
  p,
} from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConsolePort,
  getConsoleServerEnv,
  isConsoleServerReady,
  loadConsoleCredentials,
  waitForConsoleReady,
  withConsoleSession,
} from "./console";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  loadVaultDeployCredentials: vi.fn(),
  readLoadedHotUpdaterEnv: vi.fn(async () => ({})),
  p: { log: { warn: vi.fn() } },
}));

describe("the console's credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reads the port without vault credentials", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      console: { port: 1422 },
    } as never);

    await expect(getConsolePort()).resolves.toBe(1422);
    expect(vi.mocked(loadConfig).mock.calls).toEqual([[null]]);
  });

  it("loads them from another Console for the server to inherit", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", "https://console.example.com");
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", `hu_vault_${"C".repeat(43)}`);

    await loadConsoleCredentials(1422);

    expect(loadVaultDeployCredentials).toHaveBeenCalledTimes(1);
    expect(p.log.warn).not.toHaveBeenCalled();
  });

  it("does not ask the console it starts, which cannot answer yet", async () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_URL", "http://localhost:1422");
    vi.stubEnv("HOT_UPDATER_VAULT_TOKEN", `hu_vault_${"C".repeat(43)}`);

    await loadConsoleCredentials(1422);

    expect(loadVaultDeployCredentials).not.toHaveBeenCalled();
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("is this console (http://localhost:1422)"),
    );
  });
});

describe("getConsoleServerEnv", () => {
  it.each([
    {
      name: "defaults an unset host to loopback",
      processEnv: {},
      expectedHost: "127.0.0.1",
    },
    {
      name: "defaults a blank host to loopback",
      processEnv: { NITRO_HOST: " \t " },
      expectedHost: "127.0.0.1",
    },
    {
      name: "overrides an explicit public host",
      processEnv: { NITRO_HOST: "0.0.0.0" },
      expectedHost: "127.0.0.1",
    },
  ])("$name", ({ processEnv, expectedHost }) => {
    const env = getConsoleServerEnv(4_321, "run-session", processEnv);

    expect(env).toMatchObject({
      PORT: "4321",
      NITRO_PORT: "4321",
      NITRO_HOST: expectedHost,
    });
  });

  it("gives the server the run's session, over one the shell set", () => {
    expect(
      getConsoleServerEnv(4_321, "run-session", {
        HOT_UPDATER_CONSOLE_SESSION: "from-the-shell",
      }),
    ).toMatchObject({ HOT_UPDATER_CONSOLE_SESSION: "run-session" });
  });
});

describe("withConsoleSession", () => {
  it("adds the run's session to a console link, keeping its own query", () => {
    expect(
      withConsoleSession("http://localhost:1422/?platform=ios", "a-b_c"),
    ).toBe("http://localhost:1422/?platform=ios&hot-updater-session=a-b_c");
  });
});

describe("isConsoleServerReady", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the console server responds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(isConsoleServerReady(3_000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000", {
      method: "HEAD",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns false when the console server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    await expect(isConsoleServerReady(3_000)).resolves.toBe(false);
  });
});

describe("waitForConsoleReady", () => {
  const child = {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
  };

  it("waits until the readiness probe succeeds", async () => {
    const checkReady = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      waitForConsoleReady({
        child,
        port: 3_000,
        checkReady,
        pollIntervalMs: 0,
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(checkReady).toHaveBeenCalledTimes(3);
  });

  it("fails fast when the child exits before becoming ready", async () => {
    await expect(
      waitForConsoleReady({
        child: {
          exitCode: 1,
          signalCode: null,
        },
        port: 3_000,
      }),
    ).rejects.toThrow(
      "Console server exited before it became ready (exit code: 1).",
    );
  });

  it("fails when readiness never succeeds before the timeout", async () => {
    await expect(
      waitForConsoleReady({
        child,
        port: 3_000,
        timeoutMs: 0,
        checkReady: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow("Timed out waiting for the console server on port 3000.");
  });
});

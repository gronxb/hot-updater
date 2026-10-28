import { p, loadConfig } from "@hot-updater/cli-tools";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConsolePort,
  getConsoleServerEnv,
  isConsoleServerReady,
  waitForConsoleReady,
  withConsoleSession,
} from "./console";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
}));

describe("the console's port", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reads the port from the config", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      console: { port: 1422 },
    } as never);

    await expect(getConsolePort()).resolves.toBe(1422);
    expect(vi.mocked(loadConfig).mock.calls).toEqual([[null]]);
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

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});

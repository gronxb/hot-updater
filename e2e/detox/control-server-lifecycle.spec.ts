import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  monitorControlServerChild,
  stopControlServerChild,
  waitForControlServer,
} from "./scripts/control-server-lifecycle";

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  onKill: (signal: NodeJS.Signals) => void = () => {};

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }
}

function childProcess(child: FakeChild) {
  return child as unknown as import("node:child_process").ChildProcess;
}

describe("Detox control server lifecycle", () => {
  it("rejects a stale listener when the newly spawned child exits", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));
    const fetch = vi.fn(async () =>
      Response.json({ startupNonce: "stale-process" }),
    );
    const delay = vi.fn(async () => {
      child.emit("close", 1, null);
    });

    await expect(
      waitForControlServer("http://127.0.0.1:3107", "new-process", monitor, {
        delay,
        fetch,
        maxAttempts: 2,
      }),
    ).rejects.toThrow("exited before readiness (code=1, signal=null)");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never accepts a successful health response with the wrong nonce", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));

    await expect(
      waitForControlServer("http://127.0.0.1:3107", "expected", monitor, {
        fetch: vi.fn(async () => Response.json({ startupNonce: "other" })),
        maxAttempts: 1,
      }),
    ).rejects.toThrow("startup nonce mismatch");
  });

  it("accepts only the matching child health nonce", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));

    await expect(
      waitForControlServer("http://127.0.0.1:3107", "expected", monitor, {
        fetch: vi.fn(async () => Response.json({ startupNonce: "expected" })),
        maxAttempts: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("confirms graceful shutdown without sending SIGKILL", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));
    child.onKill = (signal) => {
      if (signal === "SIGTERM") child.emit("close", 0, signal);
    };

    await stopControlServerChild(childProcess(child), monitor, {
      delay: async () => {},
    });

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("forces shutdown after the graceful timeout and confirms close", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));
    child.onKill = (signal) => {
      if (signal === "SIGKILL") child.emit("close", null, signal);
    };

    await stopControlServerChild(childProcess(child), monitor, {
      delay: async () => {},
    });

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails when the child remains open after SIGKILL", async () => {
    const child = new FakeChild();
    const monitor = monitorControlServerChild(childProcess(child));

    await expect(
      stopControlServerChild(childProcess(child), monitor, {
        delay: async () => {},
      }),
    ).rejects.toThrow("did not close after SIGKILL");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

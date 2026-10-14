import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("./native", () => ({
  takeNativeUpdateEvents: () => {
    const value = queue.value;
    queue.value = null;
    return value;
  },
}));

import { replayNativeUpdateEvents } from "./nativeUpdateEvents";

const replay = () => {
  const events: { name: string; payload: unknown }[] = [];
  replayNativeUpdateEvents((name, createPayload) => {
    events.push({ name, payload: createPayload() });
  });
  return events;
};

describe("replayNativeUpdateEvents", () => {
  beforeEach(() => {
    queue.value = null;
  });

  it("emits the queued events in order and clears the queue", () => {
    const check = {
      status: "UPDATE_AVAILABLE",
      channel: "production",
      fromBundleId: "a",
      fromReleaseId: null,
      toBundleId: "b",
      toReleaseId: "r",
      transitionKind: "INSTALL",
      updateStatus: "UPDATE",
      shouldForceUpdate: true,
      updateStrategy: "fingerprint",
    };
    const downloaded = {
      channel: "production",
      fromBundleId: "a",
      fromReleaseId: null,
      toBundleId: "b",
      toReleaseId: "r",
      updateStrategy: "fingerprint",
      delivery: "manifest",
      patchFallback: false,
    };
    queue.value = JSON.stringify([
      { name: "onUpdateCheck", payload: check },
      { name: "onBundleDownloaded", payload: downloaded },
    ]);

    expect(replay()).toEqual([
      { name: "onUpdateCheck", payload: check },
      { name: "onBundleDownloaded", payload: downloaded },
    ]);
    expect(queue.value).toBeNull();
    expect(replay()).toEqual([]);
  });

  it("emits the catalog and artifact responses native checks received", () => {
    const response = {
      resource: "catalog",
      path: "/api/release-catalogs/app-version/ios/production/1.0.0",
      status: 200,
      body: "{}",
      bodyTruncated: false,
    };
    queue.value = JSON.stringify([
      { name: "onHttpResponse", payload: response, occurredAt: 5 },
    ]);

    expect(replay()).toEqual([
      { name: "onHttpResponse", payload: { ...response, occurredAt: 5 } },
    ]);
  });

  it("turns a native error message into the cause", () => {
    queue.value = JSON.stringify([
      {
        name: "onUpdateError",
        payload: {
          stage: "check",
          reason: "http",
          resource: "catalog",
          httpStatus: 500,
          channel: "production",
          bundleId: "a",
          releaseId: null,
          updateStrategy: "appVersion",
          message: "Server error",
        },
      },
    ]);

    const [event] = replay();

    expect(event?.name).toBe("onUpdateError");
    expect(event?.payload).toMatchObject({
      stage: "check",
      reason: "http",
      httpStatus: 500,
    });
    expect(event?.payload).not.toHaveProperty("message");
    expect(event?.payload).toHaveProperty("cause", new Error("Server error"));
  });

  it("skips malformed and unknown entries", () => {
    queue.value = JSON.stringify([
      null,
      { name: "onUpdateCheck" },
      { name: "onSomethingElse", payload: {} },
      {
        name: "onUpdateCheck",
        payload: { status: "UNCHANGED", channel: "production" },
      },
    ]);

    expect(replay()).toEqual([
      {
        name: "onUpdateCheck",
        payload: { status: "UNCHANGED", channel: "production" },
      },
    ]);
  });

  it("passes the time each event happened as occurredAt", () => {
    queue.value = JSON.stringify([
      {
        name: "onBundleDownloaded",
        payload: { toBundleId: "b" },
        occurredAt: 1_700_000_000_000,
      },
    ]);

    expect(replay()).toEqual([
      {
        name: "onBundleDownloaded",
        payload: { toBundleId: "b", occurredAt: 1_700_000_000_000 },
      },
    ]);
  });

  it("drops a queue that is not a JSON array", () => {
    queue.value = "{";

    expect(replay()).toEqual([]);
    expect(queue.value).toBeNull();
  });
});

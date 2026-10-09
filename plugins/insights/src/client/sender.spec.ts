import { isUUIDv7 } from "@hot-updater/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUUIDv7 } from "./eventId";
import {
  createInsightsEventSender,
  type InsightsEventBody,
  type InsightsEventGate,
} from "./sender";

const unchangedEvent = (): InsightsEventBody => ({
  appVersion: "1.0.0",
  channel: "production",
  cohort: "123",
  eventId: createUUIDv7(),
  fingerprintHash: null,
  fromBundleId: null,
  fromReleaseId: null,
  installId: "install-id",
  platform: "ios",
  sdkVersion: "test-sdk-version",
  minBundleId: "min-bundle-id",
  toBundleId: "bundle-id",
  toReleaseId: null,
  type: "UNCHANGED",
  updateStrategy: null,
});

const downloadedEvent = (): InsightsEventBody => ({
  ...unchangedEvent(),
  fromBundleId: "bundle-id",
  toBundleId: "next-bundle-id",
  type: "UPDATE_DOWNLOADED",
  updateStrategy: "appVersion",
});

/** Answers each POST /events with the next response, then 204. */
const stubEventsEndpoint = (...responses: (number | Response | Error)[]) => {
  const fetchMock = vi.fn(
    async (_path: string, _init?: RequestInit): Promise<Response> => {
      const next = responses.shift() ?? 204;
      if (next instanceof Error) throw next;
      return typeof next === "number"
        ? new Response(null, { status: next })
        : next;
    },
  );
  const sentEvents = () =>
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as InsightsEventBody,
    );
  return { fetchMock, sentEvents };
};

const openGate = () => ({
  admit: () => true,
  settle: vi.fn<InsightsEventGate["settle"]>(),
});

describe("Insights event delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter: the first retry waits exactly 1 s and the second 2 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts to events and retries a 503 in the background under the same UUIDv7 eventId", async () => {
    const { fetchMock, sentEvents } = stubEventsEndpoint(503, 204);
    const gate = openGate();
    const send = createInsightsEventSender(fetchMock, gate);

    // Settles after the failed first attempt, without waiting for the retry.
    await send(unchangedEvent());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("events");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = sentEvents();
    expect(isUUIDv7(first?.eventId)).toBe(true);
    expect(second?.eventId).toBe(first?.eventId);
    expect(gate.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "UNCHANGED" }),
      "delivered",
    );
  });

  it("waits for a 429's Retry-After before the next attempt", async () => {
    const { fetchMock } = stubEventsEndpoint(
      new Response(null, { headers: { "Retry-After": "7" }, status: 429 }),
    );
    const send = createInsightsEventSender(fetchMock, openGate());

    await send(unchangedEvent());
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a server's Retry-After at 30 seconds", async () => {
    const { fetchMock } = stubEventsEndpoint(
      new Response(null, { headers: { "Retry-After": "3600" }, status: 503 }),
    );
    const send = createInsightsEventSender(fetchMock, openGate());

    await send(unchangedEvent());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const { fetchMock } = stubEventsEndpoint(400);
    const gate = openGate();
    const send = createInsightsEventSender(fetchMock, gate);

    await expect(send(unchangedEvent())).rejects.toThrow(
      "Expected HTTP 204 from /events, received 400",
    );
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(gate.settle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "UNCHANGED" }),
      "failed",
    );
  });

  it("settles an UPDATE_FAILED event an older server refuses with 400, without retrying", async () => {
    const { fetchMock } = stubEventsEndpoint(400);
    const gate = openGate();
    const send = createInsightsEventSender(fetchMock, gate);

    await send({ ...unchangedEvent(), type: "UPDATE_FAILED" });
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(gate.settle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "UPDATE_FAILED" }),
      "refused",
    );
  });

  it("settles a 404, from a server without Insights, as Insights off without retrying", async () => {
    const { fetchMock } = stubEventsEndpoint(404);
    const gate = openGate();
    const send = createInsightsEventSender(fetchMock, gate);

    await send(unchangedEvent());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(gate.settle).toHaveBeenCalledWith(
      expect.objectContaining({ type: "UNCHANGED" }),
      "disabled",
    );
  });

  it("skips an event the gate does not admit", async () => {
    const { fetchMock } = stubEventsEndpoint();
    const gate = { admit: vi.fn(() => false), settle: vi.fn() };
    const send = createInsightsEventSender(fetchMock, gate);

    await send(unchangedEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate.settle).not.toHaveBeenCalled();
  });

  it("asks the gate before every attempt, after earlier events settled", async () => {
    const { fetchMock } = stubEventsEndpoint(503, 204);
    const order: string[] = [];
    const gate: InsightsEventGate = {
      admit: (event) => {
        order.push(`admit ${event.type}`);
        return true;
      },
      settle: (event, delivery) => {
        order.push(`${delivery} ${event.type}`);
      },
    };
    const send = createInsightsEventSender(fetchMock, gate);

    await send(unchangedEvent());
    await send(downloadedEvent());
    await vi.runAllTimersAsync();

    expect(order).toEqual([
      "admit UNCHANGED",
      "admit UNCHANGED",
      "delivered UNCHANGED",
      "admit UPDATE_DOWNLOADED",
      "delivered UPDATE_DOWNLOADED",
    ]);
  });

  it("drops an event the gate stops admitting during its backoff", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchMock, sentEvents } = stubEventsEndpoint(503);
    let wanted = true;
    const gate = { admit: vi.fn(() => wanted), settle: vi.fn() };
    const send = createInsightsEventSender(fetchMock, gate);

    await send({ ...unchangedEvent(), type: "UPDATE_FAILED" });
    wanted = false;
    await vi.runAllTimersAsync();
    wanted = true;
    await send(downloadedEvent());

    expect(sentEvents().map(({ type }) => type)).toEqual([
      "UPDATE_FAILED",
      "UPDATE_DOWNLOADED",
    ]);
    expect(gate.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "UPDATE_DOWNLOADED" }),
      "delivered",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops after three attempts and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchMock } = stubEventsEndpoint(
      500,
      new Error("network unavailable"),
      503,
    );
    const send = createInsightsEventSender(fetchMock, openGate());

    await send(unchangedEvent());
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[HotUpdater] Insights UNCHANGED event was not delivered:",
      expect.objectContaining({
        message: "Expected HTTP 204 from /events, received 503",
      }),
    );
  });

  it("sends a later event after an earlier event's retries without holding its caller", async () => {
    const { fetchMock, sentEvents } = stubEventsEndpoint(503);
    const send = createInsightsEventSender(fetchMock, openGate());

    await send(unchangedEvent());
    await send(downloadedEvent());
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();
    const [first, retry, later] = sentEvents();
    expect([first?.type, retry?.type, later?.type]).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UPDATE_DOWNLOADED",
    ]);
    expect(retry?.eventId).toBe(first?.eventId);
    expect(later?.eventId).not.toBe(first?.eventId);
  });

  it("keeps sending events after one fails outside its requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const { fetchMock, sentEvents } = stubEventsEndpoint(500, 500, 500);
    const send = createInsightsEventSender(fetchMock, openGate());

    await send(unchangedEvent());
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A queue left rejected would never send this event or settle its caller.
    await send(downloadedEvent());
    expect(sentEvents().map(({ type }) => type)).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UNCHANGED",
      "UPDATE_DOWNLOADED",
    ]);
  });
});

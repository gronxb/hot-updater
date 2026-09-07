// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  report: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator() {
      return this;
    },
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));
vi.mock("./server/insightsRecovery", () => ({
  getRecoveryReport: mocks.report,
}));

vi.mock("./server/bundleActivity", () => ({
  getBundleActivity: mocks.activity,
}));

import {
  getBundleActivityRpc,
  readBundleActivityInput,
  getRecoveryReportRpc,
} from "./insights-recovery-rpc";

afterEach(() => vi.resetAllMocks());

describe("recovery report access", () => {
  const data = {
    platform: "ios",
    channel: "production",
    window: "7d",
    releaseId: "promoted-id",
  } as const;

  it("uses the authenticated console database and preserves the requested ID", async () => {
    const model = {};
    mocks.prepare.mockResolvedValue({
      config: { database: { models: { insights: model } } },
    });
    mocks.report.mockResolvedValue({ series: [] });
    await expect(getRecoveryReportRpc({ data })).resolves.toEqual({
      series: [],
    });
    expect(mocks.report).toHaveBeenCalledWith(model, data);
  });

  it("does not read report history when console access is denied", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.prepare.mockRejectedValue(denied);
    await expect(getRecoveryReportRpc({ data })).rejects.toBe(denied);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});

describe("bundle activity access", () => {
  const data = [
    { platform: "ios", channel: "production", releaseId: "release-a" },
  ] as const;
  it("authenticates batch requests and uses the console database", async () => {
    const model = {};
    mocks.prepare.mockResolvedValue({
      config: { database: { models: { insights: model } } },
    });
    mocks.activity.mockResolvedValue({});
    await expect(getBundleActivityRpc({ data: [...data] })).resolves.toEqual(
      {},
    );
    expect(mocks.activity).toHaveBeenCalledWith(model, data);
    mocks.prepare.mockRejectedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    mocks.activity.mockClear();
    await expect(
      getBundleActivityRpc({ data: [...data] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.activity).not.toHaveBeenCalled();
  });
  it("bounds the batch and rejects an absent ID before querying", () => {
    expect(() =>
      readBundleActivityInput(Array.from({ length: 21 }, () => data[0])),
    ).toThrow("up to 20");
    expect(() =>
      readBundleActivityInput([{ ...data[0], releaseId: "" }]),
    ).toThrow();
    expect(() =>
      readBundleActivityInput([{ ...data[0], channel: "" }]),
    ).toThrow();
    expect(readBundleActivityInput(data)).toEqual(data);
  });
});

import {
  attachCapabilityContribution,
  defineCapability,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi, type Mock } from "vitest";

import { createHotUpdater } from "./createHotUpdaterCore";
import {
  defineFirstPartyFeatureManifest,
  type NoFeatureApiKind,
} from "./internal/first-party-plugin";
import {
  createRuntimeDatabase,
  createRuntimeStorage,
} from "./runtime.testFixtures";

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const createOwnedStorages = (
  events: string[],
  borrowedUnmount: Mock<() => void>,
) => {
  const borrowed = createRuntimeStorage(async () => ({
    fileUrl: "https://borrowed.example.com",
  }));
  borrowed.supportedProtocol = "borrowed";
  borrowed.onUnmount = borrowedUnmount;
  const first = createRuntimeStorage(async () => ({
    fileUrl: "https://first.example.com",
  }));
  first.supportedProtocol = "first";
  first.onUnmount = async () => {
    events.push("first:start");
    await Promise.resolve();
    events.push("first:settled");
    throw new Error("first cleanup failure");
  };
  const second = createRuntimeStorage(async () => ({
    fileUrl: "https://second.example.com",
  }));
  second.supportedProtocol = "second";
  second.onUnmount = async () => {
    events.push("second:start");
    await Promise.resolve();
    events.push("second:settled");
  };
  return { borrowed, first, second };
};

const expectRollback = async (
  construct: () => unknown,
  primary: Error,
  events: string[],
  borrowedUnmount: Mock<() => void>,
) => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  let thrown: unknown;
  try {
    construct();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    thrown = error;
  }
  await nextTurn();
  process.off("unhandledRejection", unhandled);

  expect(thrown).toBe(primary);
  expect(events).toEqual([
    "second:start",
    "first:start",
    "second:settled",
    "first:settled",
  ]);
  expect(borrowedUnmount).not.toHaveBeenCalled();
  expect(unhandled).not.toHaveBeenCalled();
};

describe("runtime partial-initialization rollback acceptance", () => {
  it("preserves factory N failure while asynchronously rolling back prior owners", async () => {
    // Given
    const events: string[] = [];
    const borrowedUnmount = vi.fn<() => void>();
    const { borrowed, first, second } = createOwnedStorages(
      events,
      borrowedUnmount,
    );
    const primary = new Error("factory N failure");

    // When / Then
    await expectRollback(
      () =>
        createHotUpdater({
          database: createRuntimeDatabase(),
          storages: [
            borrowed,
            () => first,
            () => second,
            () => {
              throw primary;
            },
          ],
        }),
      primary,
      events,
      borrowedUnmount,
    );
  });

  it("preserves route-construction failure while rolling back prior owners", async () => {
    // Given
    const events: string[] = [];
    const borrowedUnmount = vi.fn<() => void>();
    const { borrowed, first, second } = createOwnedStorages(
      events,
      borrowedUnmount,
    );
    const primary = new Error("route construction failure");
    const createRoute = () => {
      throw primary;
    };
    const feature = defineFirstPartyFeatureManifest<
      "fault",
      NoFeatureApiKind,
      {}
    >({
      aliases: {},
      id: "route-fault",
      namespace: "fault",
      setup: () => ({ routes: [createRoute()] }),
      version: "1.0.0",
    });

    // When / Then
    await expectRollback(
      () =>
        createHotUpdater({
          database: createRuntimeDatabase(),
          plugins: [feature],
          storages: [borrowed, () => first, () => second],
        }),
      primary,
      events,
      borrowedUnmount,
    );
  });

  it("preserves capability-composition failure while rolling back prior owners", async () => {
    // Given
    const events: string[] = [];
    const borrowedUnmount = vi.fn<() => void>();
    const { borrowed, first, second } = createOwnedStorages(
      events,
      borrowedUnmount,
    );
    const primary = new Error("capability composition failure");
    const token = defineCapability({
      id: "fault@1",
      parse: String,
    });
    const database = attachCapabilityContribution(createRuntimeDatabase(), {
      token,
      create() {
        throw primary;
      },
    });
    const feature = defineFirstPartyFeatureManifest<
      "fault",
      NoFeatureApiKind,
      {}
    >({
      aliases: {},
      id: "capability-fault",
      namespace: "fault",
      requires: [{ missing: "error", token }],
      setup: () => ({}),
      version: "1.0.0",
    });

    // When / Then
    await expectRollback(
      () =>
        createHotUpdater({
          database,
          plugins: [feature],
          storages: [borrowed, () => first, () => second],
        }),
      primary,
      events,
      borrowedUnmount,
    );
  });
});

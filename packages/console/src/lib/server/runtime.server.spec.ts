// @vitest-environment node

import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeHotUpdater } from "./runtime.server";

const insights = {
  record: vi.fn(async () => undefined),
  countInstallations: vi.fn(async () => 0),
  countEvents: vi.fn(async () => 0),
  listEvents: vi.fn(async () => []),
  findInstallations: vi.fn(async () => []),
};

describe("createRuntimeHotUpdater", () => {
  it("exposes the database's required Insights model", () => {
    const database = {
      models: { insights },
    } as unknown as DatabasePlugin;

    expect(createRuntimeHotUpdater({ database }).listEvents).toBeTypeOf(
      "function",
    );
  });
});

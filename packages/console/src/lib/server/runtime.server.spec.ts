// @vitest-environment node

import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeHotUpdater } from "./runtime.server";

const insights = {
  append: vi.fn(async () => undefined),
  countActiveInstallations: vi.fn(async () => 0),
  getInstallation: vi.fn(async () => null),
  pageEvents: vi.fn(async () => []),
  pageInstallationsByCurrentUserId: vi.fn(async () => []),
};

describe("createRuntimeHotUpdater", () => {
  it("exposes the database's required Insights model", () => {
    const database = {
      models: { insights },
    } as unknown as DatabasePlugin;

    expect(createRuntimeHotUpdater({ database }).pageEvents).toBeTypeOf(
      "function",
    );
  });
});

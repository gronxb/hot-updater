import { describe, expect, it, vi } from "vitest";

import { createRemoteConfigApiWriter } from "./remote-config-api-writer.ts";

const version = (number: number) => ({
  version: number,
  description: null,
  updateType: "PUBLISH" as const,
  rollbackSource: null,
  createdAtMs: 0,
});

const fakeApi = (activeVersion: number) => ({
  getActive: vi.fn(async () => ({
    version: activeVersion,
    template: {},
    updatedAtMs: null,
  })),
  publish: vi.fn(async () => ({
    status: "published" as const,
    version: version(activeVersion + 1),
  })),
  rollback: vi.fn(async () => ({
    status: "published" as const,
    version: version(activeVersion + 1),
  })),
});

describe("createRemoteConfigApiWriter", () => {
  it("publishes from the active version and answers the new one", async () => {
    const api = fakeApi(4);
    const writer = createRemoteConfigApiWriter(api);

    await expect(
      writer.publish({ template: { parameters: {} }, description: "E2E" }),
    ).resolves.toBe(5);
    expect(api.publish).toHaveBeenCalledWith({
      template: { parameters: {} },
      baseVersion: 4,
      description: "E2E",
    });
  });

  it("rolls back from the active version and answers the new one", async () => {
    const api = fakeApi(6);
    const writer = createRemoteConfigApiWriter(api);

    await expect(writer.rollback(2)).resolves.toBe(7);
    expect(api.rollback).toHaveBeenCalledWith({ version: 2, baseVersion: 6 });
  });

  it("throws for a conflict and for a version that does not exist", async () => {
    const api = fakeApi(3);
    api.publish.mockResolvedValueOnce({
      status: "conflict",
      currentVersion: 4,
    } as never);
    api.rollback.mockResolvedValueOnce({ status: "not_found" } as never);
    api.rollback.mockResolvedValueOnce({
      status: "conflict",
      currentVersion: 4,
    } as never);
    const writer = createRemoteConfigApiWriter(api);

    await expect(writer.publish({ template: {} })).rejects.toThrow(
      "version 4 was published after version 3",
    );
    await expect(writer.rollback(9)).rejects.toThrow(
      "version 9 does not exist",
    );
    await expect(writer.rollback(1)).rejects.toThrow(
      "version 4 was published after version 3",
    );
  });
});

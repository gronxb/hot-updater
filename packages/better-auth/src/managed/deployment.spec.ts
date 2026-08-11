import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  UniversalComponentDataSource,
  UniversalComponentRow,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedAccessKeyComponentSchema } from "./accessKeys";
import { prepareManagedBetterAuthDeployment } from "./provisioning";

const mocks = vi.hoisted(() => ({
  requireUniversalComponentDataSource: vi.fn(),
}));

vi.mock("@hot-updater/server/db", () => ({
  requireUniversalComponentDataSource:
    mocks.requireUniversalComponentDataSource,
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  mocks.requireUniversalComponentDataSource.mockReset();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const createSource = () => {
  const rows = new Map<string, UniversalComponentRow>();
  const source: UniversalComponentDataSource = {
    append: async () => undefined,
    assertReady: async () => undefined,
    create: async ({ row, table }) => {
      const key = `${table}:${String(row.id)}`;
      if (rows.has(key)) return "existing";
      rows.set(key, structuredClone(row));
      return "created";
    },
    get: async ({ primaryKey, table }) =>
      structuredClone(rows.get(`${table}:${primaryKey}`) ?? null),
    orderedScan: async () => [],
    schema: managedAccessKeyComponentSchema,
  };
  return { rows, source };
};

describe("prepareManagedBetterAuthDeployment", () => {
  it("owns provisioning and stores only component metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "better-auth-deploy-"));
    temporaryDirectories.push(directory);
    const envFilePath = join(directory, ".env.hotupdater");
    const target = { adapterName: "test" };
    const { rows, source } = createSource();
    mocks.requireUniversalComponentDataSource.mockReturnValue(source);

    const first = await prepareManagedBetterAuthDeployment({
      envFilePath,
      target,
    });
    const second = await prepareManagedBetterAuthDeployment({
      envFilePath,
      target,
    });

    expect(mocks.requireUniversalComponentDataSource).toHaveBeenCalledWith(
      target,
      managedAccessKeyComponentSchema,
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      message: expect.stringMatching(
        /^HOT_UPDATER_API_KEY=[A-Za-z0-9_-]{43}$/u,
      ),
      title: "Client access key (shown once)",
    });
    expect(second).toEqual([]);
    expect(rows.size).toBe(1);
    expect(JSON.stringify([...rows.values()])).not.toContain(
      first[0]!.message.split("=")[1],
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getHotUpdaterEnvValue,
  readHotUpdaterEnv,
  readHotUpdaterInitEnv,
} from "./hotUpdaterEnv";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readHotUpdaterEnv", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) =>
        fs.rm(directory, { force: true, recursive: true }),
      ),
    );
    temporaryDirectories.length = 0;
  });

  it("returns saved values when the env file exists", async () => {
    // Given
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      [
        "# init state",
        "HOT_UPDATER_INIT_BUILD=expo",
        'HOT_UPDATER_INIT_PROVIDER="cloudflare"',
        "TOKEN='value=with=equals'",
      ].join("\n"),
    );

    // When
    const env = await readHotUpdaterEnv(directory);

    // Then
    expect(env).toEqual({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_INIT_PROVIDER: "cloudflare",
      TOKEN: "value=with=equals",
    });
  });

  it("returns an empty object when the env file does not exist", async () => {
    // Given
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);

    // When
    const env = await readHotUpdaterEnv(directory);

    // Then
    expect(env).toEqual({});
  });

  it("overlays an explicit init env file without modifying the saved file", async () => {
    // Given
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      [
        "HOT_UPDATER_INIT_BUILD=bare",
        "HOT_UPDATER_INIT_PROVIDER=cloudflare",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(directory, "init.env"),
      [
        "HOT_UPDATER_INIT_BUILD=expo",
        "HOT_UPDATER_SUPABASE_DB_PASSWORD=temporary-secret",
        'TOKEN="value with \\"quotes\\""',
      ].join("\n"),
    );

    // When
    const { env, managedEnv } = await readHotUpdaterInitEnv(
      directory,
      "init.env",
    );

    // Then
    expect(env).toEqual({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_INIT_PROVIDER: "cloudflare",
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-secret",
      TOKEN: 'value with "quotes"',
    });
    expect(managedEnv).toEqual({
      HOT_UPDATER_INIT_BUILD: "bare",
      HOT_UPDATER_INIT_PROVIDER: "cloudflare",
    });
  });

  it("fails when an explicitly requested init env file does not exist", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);
    await expect(
      readHotUpdaterInitEnv(directory, "missing.env"),
    ).rejects.toThrow(
      `Init environment file not found: ${path.join(directory, "missing.env")}`,
    );
  });

  it("reuses the managed env file as explicit init input", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      ["HOT_UPDATER_INIT_BUILD=bare", "HOT_UPDATER_INIT_PROVIDER=aws"].join(
        "\n",
      ),
    );

    await expect(
      readHotUpdaterInitEnv(directory, ".env.hotupdater"),
    ).resolves.toEqual({
      env: {
        HOT_UPDATER_INIT_BUILD: "bare",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
      managedEnv: {
        HOT_UPDATER_INIT_BUILD: "bare",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
    });
  });
});

describe("getHotUpdaterEnvValue", () => {
  it("does not let a lower-priority file override an explicit false value", () => {
    vi.stubEnv("HOT_UPDATER_AWS_MIGRATION_APPROVED", "false");

    expect(
      getHotUpdaterEnvValue(
        { HOT_UPDATER_AWS_MIGRATION_APPROVED: "true" },
        "HOT_UPDATER_AWS_MIGRATION_APPROVED",
      ),
    ).toBe("false");
  });

  it("does not fall back when the process environment explicitly clears a value", () => {
    vi.stubEnv("HOT_UPDATER_AWS_MIGRATION_APPROVED", "");

    expect(
      getHotUpdaterEnvValue(
        { HOT_UPDATER_AWS_MIGRATION_APPROVED: "true" },
        "HOT_UPDATER_AWS_MIGRATION_APPROVED",
      ),
    ).toBeUndefined();
  });
});

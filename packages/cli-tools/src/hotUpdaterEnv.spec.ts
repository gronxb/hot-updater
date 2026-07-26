import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHotUpdaterEnv, readHotUpdaterInitEnv } from "./hotUpdaterEnv";

const temporaryDirectories: string[] = [];

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
      ].join("\n"),
    );

    // When
    const { env, inputEnv } = await readHotUpdaterInitEnv(
      directory,
      "init.env",
    );

    // Then
    expect(env).toEqual({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_INIT_PROVIDER: "cloudflare",
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-secret",
    });
    expect(inputEnv).toEqual({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-secret",
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

  it("keeps the explicit init env file separate from managed output", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-env-"),
    );
    temporaryDirectories.push(directory);

    await expect(
      readHotUpdaterInitEnv(directory, ".env.hotupdater"),
    ).rejects.toThrow("Init input file must be separate from managed output");
  });
});

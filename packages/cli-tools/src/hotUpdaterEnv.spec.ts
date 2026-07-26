import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHotUpdaterEnv } from "./hotUpdaterEnv";

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
});

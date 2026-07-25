import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HOT_UPDATER_API_KEY_ENV_NAME,
  provisionManagedBetterAuthApiKey,
} from "@hot-updater/better-auth/managed/provisioning";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("AWS managed API-key provisioning", () => {
  it("reuses the existing client credential across repeated initialization", async () => {
    // Given: AWS initialization writes to a new .env.hotupdater file.
    const directory = await mkdtemp(path.join(os.tmpdir(), "hot-updater-aws-"));
    temporaryDirectories.push(directory);
    const envFilePath = path.join(directory, ".env.hotupdater");

    // When: initialization provisions the credential twice.
    const first = await provisionManagedBetterAuthApiKey({ envFilePath });
    const second = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then: both deployments receive the same digest and only one raw key is stored.
    expect(second).toEqual(first);
    const content = await readFile(envFilePath, "utf8");
    expect(
      content
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(`${HOT_UPDATER_API_KEY_ENV_NAME}=`)),
    ).toHaveLength(1);
    expect(content).toContain(
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${first.apiKey}`,
    );
    expect(content).not.toContain(first.sha256);
  });
});

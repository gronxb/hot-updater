import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareFirebaseRuntimeAuth } from "./runtimeAuth";

describe("prepareFirebaseRuntimeAuth", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });

  it("reuses local provisioning and returns only the digest", async () => {
    // Given: Firebase provisions into a local environment file.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "firebase-api-key-"));
    tempDirs.push(tempDir);
    const envFilePath = path.join(tempDir, ".env.hotupdater");

    // When: Firebase prepares runtime authentication.
    const firstRuntimeAuth = await prepareFirebaseRuntimeAuth(envFilePath);
    const secondRuntimeAuth = await prepareFirebaseRuntimeAuth(envFilePath);
    const envContent = await readFile(envFilePath, "utf8");
    const rawApiKey = envContent.trim().split("=")[1] ?? "";

    // Then: repeated initialization is stable and only the digest is returned.
    expect(secondRuntimeAuth).toEqual(firstRuntimeAuth);
    expect(envContent.match(/^HOT_UPDATER_API_KEY=/gmu)).toHaveLength(1);
    expect(rawApiKey).toHaveLength(43);
    expect(Object.keys(firstRuntimeAuth)).toEqual(["API_KEY_SHA256"]);
    expect(Object.values(firstRuntimeAuth)).not.toContain(rawApiKey);
  });
});

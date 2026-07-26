import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOT_UPDATER_API_KEY_ENV_NAME,
  provisionManagedBetterAuthApiKey,
} from "./provisioning";

const fileSystemMock = vi.hoisted<{ chmodError?: unknown }>(() => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async chmod(...args: Parameters<typeof actual.chmod>) {
      if (fileSystemMock.chmodError !== undefined) {
        throw fileSystemMock.chmodError;
      }
      return actual.chmod(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "hot-updater-better-auth-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  fileSystemMock.chmodError = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("provisionManagedBetterAuthApiKey", () => {
  it("creates a canonical 32-byte key and its Better Auth hash projection", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");

    // When
    const result = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.sha256).toBe(
      createHash("sha256").update(result.apiKey).digest("base64url"),
    );
    expect(await readFile(envFilePath, "utf8")).toBe(
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
    );
  });

  it("preserves unrelated content and is byte-for-byte idempotent", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "# existing comment\nEXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");

    // When
    const first = await provisionManagedBetterAuthApiKey({ envFilePath });
    const afterFirst = await readFile(envFilePath, "utf8");
    const second = await provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    expect(afterFirst.startsWith(original)).toBe(true);
    expect(second).toEqual(first);
    expect(await readFile(envFilePath, "utf8")).toBe(afterFirst);
  });

  it.each([
    "short",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])(
    "rejects an invalid existing key %# without replacing it",
    async (value) => {
      // Given
      const directory = await createTemporaryDirectory();
      const envFilePath = join(directory, ".env.hotupdater");
      const original = `${HOT_UPDATER_API_KEY_ENV_NAME}=${value}\n`;
      await writeFile(envFilePath, original, "utf8");

      // When
      const pending = provisionManagedBetterAuthApiKey({ envFilePath });

      // Then
      await expect(pending).rejects.toThrow(HOT_UPDATER_API_KEY_ENV_NAME);
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    },
  );

  it("does not write a new key when an existing env file cannot be secured", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "EXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");
    fileSystemMock.chmodError = Object.assign(new Error("permission denied"), {
      code: "EPERM",
    });

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toThrow("permission denied");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it.each(["ENOSYS", "ENOTSUP", "EOPNOTSUPP"])(
    "rejects unsupported permission hardening for an existing env file (%s)",
    async (code) => {
      // Given
      const directory = await createTemporaryDirectory();
      const envFilePath = join(directory, ".env.hotupdater");
      const original = "EXISTING=value\n";
      await writeFile(envFilePath, original, "utf8");
      fileSystemMock.chmodError = Object.assign(
        new Error("permission hardening unsupported"),
        { code },
      );

      // When
      const pending = provisionManagedBetterAuthApiKey({ envFilePath });

      // Then
      await expect(pending).rejects.toMatchObject({ code });
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    },
  );

  it("does not leave a generated key when a new env file cannot be secured", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    fileSystemMock.chmodError = Object.assign(
      new Error("permission hardening unsupported"),
      { code: "ENOTSUP" },
    );

    // When
    const pending = provisionManagedBetterAuthApiKey({ envFilePath });

    // Then
    await expect(pending).rejects.toMatchObject({ code: "ENOTSUP" });
    await expect(readFile(envFilePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

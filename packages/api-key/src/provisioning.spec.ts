import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { apiKey } from "./index";
import { HOT_UPDATER_API_KEY_ENV_NAME, provisionApiKey } from "./provisioning";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "hot-updater-api-key-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("provisionApiKey", () => {
  it("creates a 32-byte base64url key and its SHA-256 digest", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");

    // When
    const result = await provisionApiKey({ envFilePath });

    // Then
    expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.sha256).toBe(
      createHash("sha256").update(result.apiKey).digest("base64url"),
    );
    expect(await readFile(envFilePath, "utf8")).toBe(
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
    );
    const contribution = apiKey({ sha256: result.sha256 }).setup(
      undefined as never,
    );
    await expect(
      contribution.authentication?.authenticate({
        headers: new Headers({ "x-api-key": result.apiKey }),
        method: "GET",
        route: {
          access: { kind: "protected" },
          id: "version",
          method: "GET",
          params: {},
          pattern: "/version",
        },
        signal: new AbortController().signal,
        url: new URL("https://example.com/version"),
      }),
    ).resolves.toMatchObject({ kind: "authenticated" });
  });

  it("preserves unrelated content and is byte-for-byte idempotent", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const original = "# existing comment\nEXISTING=value\n";
    await writeFile(envFilePath, original, "utf8");

    // When
    const first = await provisionApiKey({ envFilePath });
    const afterFirst = await readFile(envFilePath, "utf8");
    const second = await provisionApiKey({ envFilePath });
    const afterSecond = await readFile(envFilePath, "utf8");

    // Then
    expect(afterFirst.startsWith(original)).toBe(true);
    expect(afterFirst).toContain(
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${first.apiKey}\n`,
    );
    expect(second).toEqual(first);
    expect(afterSecond).toBe(afterFirst);
  });

  it("accepts a valid quoted existing value without rewriting the file", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const apiKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const original = `${HOT_UPDATER_API_KEY_ENV_NAME}="${apiKey}"\n`;
    await writeFile(envFilePath, original, "utf8");

    // When
    const result = await provisionApiKey({ envFilePath });

    // Then
    expect(result.apiKey).toBe(apiKey);
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });

  it.each([
    "short",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])(
    "rejects an invalid existing value without replacing it",
    async (value) => {
      // Given
      const directory = await createTemporaryDirectory();
      const envFilePath = join(directory, ".env.hotupdater");
      const original = `${HOT_UPDATER_API_KEY_ENV_NAME}=${value}\n`;
      await writeFile(envFilePath, original, "utf8");

      // When
      const pending = provisionApiKey({ envFilePath });

      // Then
      await expect(pending).rejects.toThrow(HOT_UPDATER_API_KEY_ENV_NAME);
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    },
  );

  it("rejects duplicate API key definitions as ambiguous", async () => {
    // Given
    const directory = await createTemporaryDirectory();
    const envFilePath = join(directory, ".env.hotupdater");
    const apiKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const original = [
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}`,
      `${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}`,
      "",
    ].join("\n");
    await writeFile(envFilePath, original, "utf8");

    // When / Then
    await expect(provisionApiKey({ envFilePath })).rejects.toThrow("multiple");
    expect(await readFile(envFilePath, "utf8")).toBe(original);
  });
});

import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HOT_UPDATER_API_KEY_ENV_NAME,
  provisionManagedBetterAuthApiKey,
} from "./provisioning";

const withTemporaryDirectory = async (
  action: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "better-auth-provisioning-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

describe("provisionManagedBetterAuthApiKey", () => {
  it("creates a 32-byte base64url key, known digest, and mode 0600", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");

      const result = await provisionManagedBetterAuthApiKey({ envFilePath });

      expect(result.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(result.sha256).toBe(
        createHash("sha256").update(result.apiKey).digest("base64url"),
      );
      expect(await readFile(envFilePath, "utf8")).toBe(
        `${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
      );
      expect((await stat(envFilePath)).mode & 0o777).toBe(0o600);
    });
  });

  it("preserves unrelated content and is byte-for-byte idempotent", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const original = "# existing comment\nEXISTING=value\n";
      await writeFile(envFilePath, original, "utf8");

      const first = await provisionManagedBetterAuthApiKey({ envFilePath });
      const afterFirst = await readFile(envFilePath, "utf8");
      const second = await provisionManagedBetterAuthApiKey({ envFilePath });

      expect(afterFirst).toBe(
        `${original}${HOT_UPDATER_API_KEY_ENV_NAME}=${first.apiKey}\n`,
      );
      expect(second).toEqual(first);
      expect(await readFile(envFilePath, "utf8")).toBe(afterFirst);
    });
  });

  it("produces one definition for same-process concurrent calls", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      await writeFile(envFilePath, "EXISTING=value\n", "utf8");

      const results = await Promise.all(
        Array.from({ length: 16 }, () =>
          provisionManagedBetterAuthApiKey({ envFilePath }),
        ),
      );

      expect(new Set(results.map((result) => result.apiKey))).toHaveLength(1);
      expect(
        (await readFile(envFilePath, "utf8")).match(
          new RegExp(`^${HOT_UPDATER_API_KEY_ENV_NAME}=`, "gmu"),
        ),
      ).toHaveLength(1);
    });
  });

  it("times out on a stale adjacent lock without modifying it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const lockPath = `${envFilePath}.lock`;
      const originalLock = "stale lock";
      await writeFile(lockPath, originalLock, {
        encoding: "utf8",
        mode: 0o600,
      });

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow("Timed out");

      expect(await readFile(lockPath, "utf8")).toBe(originalLock);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("rejects an invalid existing key without modifying the file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const original = `${HOT_UPDATER_API_KEY_ENV_NAME}=invalid\n`;
      await writeFile(envFilePath, original, "utf8");

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow(HOT_UPDATER_API_KEY_ENV_NAME);

      expect(await readFile(envFilePath, "utf8")).toBe(original);
    });
  });

  it("rejects duplicate existing keys without modifying the file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const key = Buffer.alloc(32, 1).toString("base64url");
      const original = `${HOT_UPDATER_API_KEY_ENV_NAME}=${key}\n${HOT_UPDATER_API_KEY_ENV_NAME}=${key}\n`;
      await writeFile(envFilePath, original, "utf8");

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow("multiple");

      expect(await readFile(envFilePath, "utf8")).toBe(original);
    });
  });

  it("rejects a symbolic-link target without changing its target", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const targetPath = join(directory, "target.env");
      const original = "EXISTING=value\n";
      await writeFile(targetPath, original, "utf8");
      await symlink(targetPath, envFilePath);

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow();

      expect(await readFile(targetPath, "utf8")).toBe(original);
    });
  });

  it("rejects a hard-linked target without modifying either link", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const targetPath = join(directory, "target.env");
      const original = "EXISTING=value\n";
      await writeFile(targetPath, original, "utf8");
      await link(targetPath, envFilePath);

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow("single hard link");

      expect(await readFile(targetPath, "utf8")).toBe(original);
      expect(await readFile(envFilePath, "utf8")).toBe(original);
    });
  });

  it("rejects a group-writable immediate parent without creating a target", async () => {
    await withTemporaryDirectory(async (directory) => {
      const parentPath = join(directory, "configuration");
      const envFilePath = join(parentPath, ".env.hotupdater");
      await mkdir(parentPath, { mode: 0o700 });
      await chmod(parentPath, 0o720);

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow("user-owned directory");

      await expect(lstat(envFilePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("leaves an oversized target unchanged", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const original = "a".repeat(1_048_577);
      await writeFile(envFilePath, original, { encoding: "utf8", mode: 0o644 });
      const originalMode = (await stat(envFilePath)).mode & 0o777;

      await expect(
        provisionManagedBetterAuthApiKey({ envFilePath }),
      ).rejects.toThrow("1 MiB");

      expect(await readFile(envFilePath, "utf8")).toBe(original);
      expect((await stat(envFilePath)).mode & 0o777).toBe(originalMode);
    });
  });

  it("rejects Windows before creating a target", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const platform = vi
        .spyOn(process, "platform", "get")
        .mockReturnValue("win32");
      try {
        await expect(
          provisionManagedBetterAuthApiKey({ envFilePath }),
        ).rejects.toThrow("Node POSIX");
      } finally {
        platform.mockRestore();
      }

      await expect(lstat(envFilePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("atomically replaces an existing keyless target while preserving the old file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFilePath = join(directory, ".env.hotupdater");
      const original = "EXISTING=value\n";
      await writeFile(envFilePath, original, { encoding: "utf8", mode: 0o644 });
      const previous = await open(envFilePath, "r");

      const result = await provisionManagedBetterAuthApiKey({ envFilePath });

      try {
        expect(await previous.readFile("utf8")).toBe(original);
      } finally {
        await previous.close();
      }
      expect(await readFile(envFilePath, "utf8")).toBe(
        `${original}${HOT_UPDATER_API_KEY_ENV_NAME}=${result.apiKey}\n`,
      );
      expect((await stat(envFilePath)).mode & 0o777).toBe(0o600);
    });
  });
});

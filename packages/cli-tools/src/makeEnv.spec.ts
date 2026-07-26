import fs from "fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv } from "./makeEnv";

vi.mock("fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      lstat: vi.fn(),
      readFile: vi.fn(),
      rename: vi.fn(),
      rm: vi.fn(),
      writeFile: vi.fn(),
    },
    readFile: vi.fn(),
  };
});

describe("makeEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.lstat).mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("adds new environment variables while preserving existing .env.hotupdater content", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("EXISTING_KEY=existing_value");
    const newEnvVars = {
      NEW_KEY: "new_value",
    };

    const result = await makeEnv(newEnvVars);

    expect(result).toBe("EXISTING_KEY=existing_value\nNEW_KEY=new_value");
  });

  it("overwrites environment variables with the same key (string value)", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("TEST_KEY=old_value");
    const newEnvVars = {
      TEST_KEY: "new_value",
    };

    const result = await makeEnv(newEnvVars);

    expect(result).toBe("TEST_KEY=new_value");
  });

  it("preserves keys that don't exist in the new environment variables", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      "EXISTING_KEY=existing_value\nNEW_KEY=old_value",
    );
    const newEnvVars = {
      NEW_KEY: "new_value",
    };

    const result = await makeEnv(newEnvVars);
    expect(result).toBe("EXISTING_KEY=existing_value\nNEW_KEY=new_value");
  });

  it("preserves existing comments and adds new keys at the end", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      "# Key\nEXISTING_KEY=existing_value\n\nNEW_KEY=old_value",
    );
    const newEnvVars = {
      NEW_KEY: "new_value",
      NEW_KEY2: "new_value2",
    };

    const result = await makeEnv(newEnvVars);
    expect(result).toBe(
      "# Key\nEXISTING_KEY=existing_value\n\nNEW_KEY=new_value\nNEW_KEY2=new_value2",
    );
  });

  it("adds new environment variable with comment object when file is empty", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("");
    const newEnvVars = {
      HI: { comment: "This Test Env", value: "ASD" },
    };

    const result = await makeEnv(newEnvVars);
    expect(result).toBe("# This Test Env\nHI=ASD");
  });

  it("overwrites existing environment variable with comment object", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("HI=old_value");
    const newEnvVars = {
      HI: { comment: "Updated Comment", value: "ASD" },
    };

    const result = await makeEnv(newEnvVars);
    expect(result).toBe("# Updated Comment\nHI=ASD");
  });

  it("mixes string and object values", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("A=1\nB=2");
    const newEnvVars = {
      A: { comment: "A comment", value: "100" },
      C: "3",
    };

    const result = await makeEnv(newEnvVars);
    expect(result).toBe("# A comment\nA=100\nB=2\nC=3");
  });

  it("preserves existing keys when requested", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      "GOOGLE_APPLICATION_CREDENTIALS=existing.json\nOTHER_KEY=old",
    );

    const result = await makeEnv(
      {
        GOOGLE_APPLICATION_CREDENTIALS: "new.json",
        OTHER_KEY: "new",
      },
      ".env.hotupdater",
      {
        preserveKeys: ["GOOGLE_APPLICATION_CREDENTIALS"],
      },
    );

    expect(result).toBe(
      "GOOGLE_APPLICATION_CREDENTIALS=existing.json\nOTHER_KEY=new",
    );
  });

  it("preserves existing commented keys when requested", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      "# Existing credential\nGOOGLE_APPLICATION_CREDENTIALS=existing.json",
    );

    const result = await makeEnv(
      {
        GOOGLE_APPLICATION_CREDENTIALS: {
          comment: "New credential",
          value: "new.json",
        },
      },
      ".env.hotupdater",
      {
        preserveKeys: ["GOOGLE_APPLICATION_CREDENTIALS"],
      },
    );

    expect(result).toBe(
      "# Existing credential\nGOOGLE_APPLICATION_CREDENTIALS=existing.json",
    );
  });

  it("removes sensitive keys when requested", async () => {
    // Given
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      [
        "HOT_UPDATER_SUPABASE_URL=https://project.supabase.co",
        "# Init-only secret",
        "HOT_UPDATER_SUPABASE_DB_PASSWORD=secret",
      ].join("\n"),
    );

    // When
    const result = await makeEnv(
      {
        HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
      },
      ".env.hotupdater",
      {
        removeKeys: ["HOT_UPDATER_SUPABASE_DB_PASSWORD"],
      },
    );

    // Then
    expect(result).toBe(
      [
        "HOT_UPDATER_SUPABASE_URL=https://project.supabase.co",
        "HOT_UPDATER_SUPABASE_FUNCTION_NAME=update-server",
      ].join("\n"),
    );
  });

  it("writes environment files with owner-only permissions", async () => {
    // Given
    vi.mocked(fs.readFile).mockResolvedValueOnce("");

    // When
    await makeEnv({ HOT_UPDATER_INIT_BUILD: "bare" });

    // Then
    const temporaryPath = vi.mocked(fs.writeFile).mock.calls[0]?.[0];
    expect(temporaryPath).toEqual(expect.stringContaining(".env.hotupdater."));
    expect(fs.writeFile).toHaveBeenCalledWith(
      temporaryPath,
      "HOT_UPDATER_INIT_BUILD=bare",
      {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      },
    );
    expect(fs.rename).toHaveBeenCalledWith(
      temporaryPath,
      path.resolve(".env.hotupdater"),
    );
  });

  it("refuses to follow a managed env symlink", async () => {
    vi.mocked(fs.lstat).mockResolvedValue({
      isFile: () => false,
      isSymbolicLink: () => true,
    } as Stats);

    await expect(makeEnv({ TOKEN: "secret" })).rejects.toThrow(
      "Refusing to write init environment values to a non-regular file",
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("rejects values that could inject another environment assignment", async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce("");

    await expect(makeEnv({ TOKEN: "secret\nINJECTED=true" })).rejects.toThrow(
      "Environment values cannot contain NUL or newlines",
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

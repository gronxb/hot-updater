import fs from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "./makeEnv";

vi.mock("fs/promises");

describe("makeEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

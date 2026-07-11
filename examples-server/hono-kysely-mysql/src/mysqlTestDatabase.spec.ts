import { afterEach, describe, expect, it, vi } from "vitest";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock("execa", () => ({ execa: execaMock }));

import {
  restoreAfterMySQLSetupFailure,
  startMySQLTestDatabase,
} from "./mysqlTestDatabase";

afterEach(() => {
  execaMock.mockReset();
  vi.useRealTimers();
});

const mockDockerLifecycle = (
  createDatabase: () => Promise<void> | void,
): void => {
  execaMock.mockImplementation(
    async (command: string, args: readonly string[] = []) => {
      const operation = args[0] === "compose" ? args[1] : args[0];
      if (operation === "config") return { stdout: '{"name":"test"}' };
      if (operation === "inspect") return { stdout: "healthy" };
      if (operation === "exec" && args.at(-1)?.startsWith("CREATE DATABASE")) {
        await createDatabase();
      }
      if (command !== "docker") {
        throw new Error(`Unexpected command: ${command}`);
      }
      return { stdout: "" };
    },
  );
};

describe("MySQL test database lifecycle", () => {
  it("preserves setup and cleanup errors", async () => {
    const setupError = new Error("setup failed");
    const cleanupError = new Error("cleanup failed");

    try {
      await restoreAfterMySQLSetupFailure(setupError, async () => {
        throw cleanupError;
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors).toEqual([setupError, cleanupError]);
      expect(error.cause).toBe(setupError);
      return;
    }

    throw new Error("Expected setup restoration to fail.");
  });

  it("rethrows the setup error when cleanup succeeds", async () => {
    const setupError = new Error("setup failed");

    await expect(
      restoreAfterMySQLSetupFailure(setupError, async () => {}),
    ).rejects.toBe(setupError);
  });

  it("retries database creation when MySQL restarts after becoming healthy", async () => {
    vi.useFakeTimers();
    let createAttempts = 0;

    mockDockerLifecycle(() => {
      createAttempts += 1;
      if (createAttempts === 1) {
        throw new Error(
          "ERROR 2002 (HY000): Can't connect to local MySQL server through socket",
        );
      }
    });

    const databasePromise = startMySQLTestDatabase("/test/project");
    await vi.runAllTimersAsync();
    const database = await databasePromise;

    try {
      expect(createAttempts).toBe(2);
    } finally {
      await database.restore();
    }
  });

  it("stops retrying after 30 MySQL connection failures", async () => {
    vi.useFakeTimers();
    let createAttempts = 0;

    mockDockerLifecycle(() => {
      createAttempts += 1;
      throw new Error(
        "ERROR 2002 (HY000): Can't connect to local MySQL server through socket",
      );
    });

    const rejection = expect(
      startMySQLTestDatabase("/test/project"),
    ).rejects.toThrow("ERROR 2002 (HY000)");
    await vi.runAllTimersAsync();
    await rejection;

    expect(createAttempts).toBe(30);
  });

  it("does not retry a different MySQL error code", async () => {
    let createAttempts = 0;

    mockDockerLifecycle(() => {
      createAttempts += 1;
      throw new Error(
        "ERROR 20020 (HY000): synthetic near-match connection error",
      );
    });

    await expect(startMySQLTestDatabase("/test/project")).rejects.toThrow(
      "ERROR 20020 (HY000)",
    );

    expect(createAttempts).toBe(1);
  });
});

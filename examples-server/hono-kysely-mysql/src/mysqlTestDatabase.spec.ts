import { describe, expect, it } from "vitest";

import { restoreAfterMySQLSetupFailure } from "./mysqlTestDatabase";

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
});

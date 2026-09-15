import { describe, expect, it } from "vitest";

import { insightsSqlKey } from "./insightsSqlKeys";

describe("Insights SQL keys", () => {
  it("hashes long Unicode identities into stable index-safe keys", async () => {
    const logicalKey = JSON.stringify([
      "ios",
      `${'😀"\\'.repeat(1024)}`,
      "00000000-0000-7000-8000-000000000001",
      "i".repeat(255),
      "downloaded",
    ]);

    const first = await insightsSqlKey(logicalKey);
    const second = await insightsSqlKey(logicalKey);
    const different = await insightsSqlKey(`${logicalKey}:different`);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(different).not.toBe(first);
  });
});

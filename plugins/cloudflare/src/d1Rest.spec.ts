import { describe, expect, it, vi } from "vitest";

import { d1Database } from "./d1Database";
import { d1RestRunner } from "./d1Rest";

describe("d1Database's API token", () => {
  it("is read from a function on the first query, not when the config loads", async () => {
    const cloudflareApiToken = vi.fn(async () => {
      throw new Error('secret("CLOUDFLARE_API_TOKEN") has no value');
    });
    const config = {
      accountId: "account-id",
      databaseId: "database-id",
      cloudflareApiToken,
    };

    d1Database(config);
    const runner = d1RestRunner(config);
    expect(cloudflareApiToken).not.toHaveBeenCalled();

    await expect(runner.query({ sql: "select 1", params: [] })).rejects.toThrow(
      'secret("CLOUDFLARE_API_TOKEN") has no value',
    );
    expect(cloudflareApiToken).toHaveBeenCalledTimes(1);
  });
});

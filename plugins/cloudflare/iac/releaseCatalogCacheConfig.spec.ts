import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("managed Cloudflare Release catalog caching", () => {
  it("enables the pre-Worker response cache on a supported compatibility date", async () => {
    const config = JSON.parse(
      await readFile(
        path.join(import.meta.dirname, "../worker/wrangler.json"),
        "utf8",
      ),
    ) as {
      cache?: { enabled?: boolean };
      compatibility_date?: string;
    };

    expect(config.cache).toEqual({ enabled: true });
    expect(config.compatibility_date).toBe("2026-08-13");
  });
});

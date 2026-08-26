import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("managed Firebase project isolation", () => {
  it("does not deploy the project's default Firebase Hosting site", async () => {
    const config = JSON.parse(
      await readFile(
        new URL("../firebase/public/firebase.json", import.meta.url),
        "utf8",
      ),
    ) as {
      hosting?: unknown;
    };

    expect(config.hosting).toBeUndefined();
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("managed Firebase Release catalog caching", () => {
  it("routes the managed API through one pinned Firebase Hosting rewrite", async () => {
    const config = JSON.parse(
      await readFile(
        new URL("../firebase/public/firebase.json", import.meta.url),
        "utf8",
      ),
    ) as {
      hosting?: {
        public?: string;
        rewrites?: readonly unknown[];
      };
    };

    expect(config.hosting).toEqual(
      expect.objectContaining({
        public: "hosting",
        rewrites: [
          {
            function: { functionId: "hot-updater", pinTag: true },
            regex: "^/(?:version|release-catalogs/.*|artifacts/.*|events)$",
          },
        ],
      }),
    );
  });
});

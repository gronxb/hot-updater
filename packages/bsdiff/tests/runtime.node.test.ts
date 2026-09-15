import { describe, expect, it } from "vitest";

import { bsdiff, hdiff } from "../src/index.js";
import { applyBsdiffPatch } from "../src/internal/bsdiff.js";
import { readFixtureHbc } from "./test-helpers.js";

describe("runtime: node", () => {
  it("runs end-to-end in Node runtime", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");
    const patch = await hdiff(base, next);
    expect(patch.byteLength).toBeGreaterThan(0);
  });

  it("roundtrips arbitrary engine-neutral artifact bytes", async () => {
    const base = new TextEncoder().encode("main.lynx.bundle version A");
    const next = new TextEncoder().encode(
      "main.lynx.bundle version B with another page",
    );

    const patch = await bsdiff(base, next);

    await expect(applyBsdiffPatch(base, patch)).resolves.toEqual(next);
  });
});

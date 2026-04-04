import { describe, expect, it } from "vitest";

import { hdiff } from "../src/index.js";
import { readFixtureHbc } from "./test-helpers.js";

describe("runtime: node", () => {
  it("runs end-to-end in Node runtime", async () => {
    const base = await readFixtureHbc("one");
    const next = await readFixtureHbc("two");
    const patch = await hdiff(base, next);
    expect(patch.byteLength).toBeGreaterThan(0);
  });
});

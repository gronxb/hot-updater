import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rechartsRequire = createRequire(require.resolve("recharts/package.json"));

describe("Recharts runtime dependencies", () => {
  it("uses the es-toolkit release compatible with Vite dependency optimization", () => {
    const esToolkitPackage = rechartsRequire("es-toolkit/package.json") as {
      readonly version: string;
    };

    expect(esToolkitPackage.version).toBe("1.46.0");
  });
});

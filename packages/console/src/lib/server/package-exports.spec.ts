// @vitest-environment node

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type PackEntry = {
  readonly files: readonly { readonly path: string }[];
};

describe("console package exports", () => {
  it("packs the source needed by embedded and hosted exports", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const [pack] = JSON.parse(output) as PackEntry[];
    const packedFiles = new Set(pack.files.map((file) => file.path));

    expect(packedFiles).toContain("src/embedded.tsx");
    expect(packedFiles).toContain("src/embedded.d.ts");
    expect(packedFiles).toContain("src/lib/server/hosted.server.ts");
    expect(packedFiles).toContain("src/lib/server/api-operations.server.ts");
    expect(packedFiles).toContain("src/lib/server/config.server.ts");
    expect(packedFiles).toContain("src/lib/server/deleteBundle.ts");
    expect(packedFiles).toContain("src/lib/server/getBundleChildren.ts");
    expect(packedFiles).toContain("src/lib/constants.ts");
  }, 15_000);
});

import { describe, expect, it } from "vitest";

import { formatUnifiedDiff } from "./unifiedDiff";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

describe("formatUnifiedDiff", () => {
  it("shows each change with three lines of context", () => {
    // Given a file with one line replaced and one line added far below it
    const before = lines(20);
    const after = [...before];
    after[2] = "changed 3";
    after.splice(15, 0, "added");

    // When the diff is formatted
    const diff = formatUnifiedDiff(
      "src/server.ts",
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
    );

    // Then each change gets its own hunk with correct line ranges
    expect(diff).toBe(
      [
        "--- a/src/server.ts",
        "+++ b/src/server.ts",
        "@@ -1,6 +1,6 @@",
        " line 1",
        " line 2",
        "-line 3",
        "+changed 3",
        " line 4",
        " line 5",
        " line 6",
        "@@ -13,6 +13,7 @@",
        " line 13",
        " line 14",
        " line 15",
        "+added",
        " line 16",
        " line 17",
        " line 18",
      ].join("\n"),
    );
  });

  it("merges changes whose context overlaps into one hunk", () => {
    const before = lines(10);
    const after = before.filter(
      (line) => line !== "line 4" && line !== "line 8",
    );

    const diff = formatUnifiedDiff("a.ts", before.join("\n"), after.join("\n"));

    expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,10 +1,8 @@",
    ]);
  });
});

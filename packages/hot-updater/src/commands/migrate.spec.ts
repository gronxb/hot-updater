import { describe, expect, it } from "vitest";

import { formatOperations } from "./migrate";

describe("migrate command operation formatting", () => {
  it("renders custom SQL and setting operations", () => {
    expect(
      formatOperations([
        {
          type: "custom",
          sql: "create index bundles_channel_idx on bundles(channel)",
        },
        {
          type: "custom",
          key: "version",
          value: "0.31.0",
        },
      ]),
    ).toEqual([
      "Run SQL: create index bundles_channel_idx on bundles(channel)",
      "Set setting: version=0.31.0",
    ]);
  });
});

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

  it("keeps a Mongo settings index repair as an executable change", () => {
    expect(
      formatOperations([
        {
          description:
            "Ensure unique MongoDB index: private_hot_updater_settings(key)",
          type: "custom",
        },
      ]),
    ).toEqual([
      "Ensure unique MongoDB index: private_hot_updater_settings(key)",
    ]);
  });
});

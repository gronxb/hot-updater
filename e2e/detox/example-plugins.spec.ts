import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadHotUpdaterPlugins } from "../../packages/cli-tools/src/hotUpdaterPlugins.ts";

const exampleDir = path.resolve(import.meta.dirname, "../../examples/v0.85.0");

describe("example app server plugins", () => {
  it("lists the managed servers' plugins, so managed profiles read Insights in process", async () => {
    // Given: a managed profile's config has a direct database plugin, and
    // managed servers serve no admin routes to fall back on.
    const plugins = (await loadHotUpdaterPlugins(exampleDir)) as
      | readonly { readonly id: string }[]
      | undefined;

    // Then: the controller assembles Insights and API keys over that database.
    expect(plugins?.map((plugin) => plugin.id)).toEqual([
      "insights",
      "apiKeys",
    ]);
  });
});

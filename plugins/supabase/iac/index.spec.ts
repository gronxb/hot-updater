import { resolvePackageVersion } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEdgeFunctionDenoConfig } from "./index";

const originalOverride = process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION;

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION;
    return;
  }

  process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION = originalOverride;
});

describe("resolveEdgeFunctionDenoConfig", () => {
  it("pins released npm specifiers when no override is set", async () => {
    delete process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION;

    const result = await resolveEdgeFunctionDenoConfig();

    expect(result).toEqual({
      imports: {
        "@hot-updater/server/runtime": `npm:@hot-updater/server@${resolvePackageVersion("@hot-updater/server")}/runtime`,
        "@hot-updater/supabase": `npm:@hot-updater/supabase@${resolvePackageVersion("@hot-updater/supabase")}`,
      },
    });
  });

  it("writes esm.sh PR imports when pkg.pr.new override is set", async () => {
    process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION =
      "https://pkg.pr.new/@hot-updater/supabase@888";

    const result = await resolveEdgeFunctionDenoConfig();

    expect(result).toEqual({
      imports: {
        "@hot-updater/server/runtime":
          "https://esm.sh/pr/gronxb/hot-updater/@hot-updater/server@888/runtime?target=deno",
        "@hot-updater/supabase":
          "https://esm.sh/pr/gronxb/hot-updater/@hot-updater/supabase@888?target=deno",
      },
    });
  });
});

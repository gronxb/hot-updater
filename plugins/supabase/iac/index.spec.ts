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

  it("writes pkg.pr.new imports when pkg.pr.new override is set", async () => {
    process.env.HOT_UPDATER_SERVER_PACKAGE_VERSION =
      "https://pkg.pr.new/@hot-updater/supabase@888";

    const result = await resolveEdgeFunctionDenoConfig();

    expect(result).toEqual({
      imports: {
        "@hot-updater/server/runtime":
          "https://pkg.pr.new/@hot-updater/server@888/runtime",
        "@hot-updater/supabase":
          "https://pkg.pr.new/@hot-updater/supabase@888",
      },
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePackageVersion } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { resolveEdgeFunctionDenoConfig } from "./index";

describe("resolveEdgeFunctionDenoConfig", () => {
  it("vendors package dist files into the edge function directory", async () => {
    const targetDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-edge-"),
    );
    try {
      const result = await resolveEdgeFunctionDenoConfig(targetDir);

      expect(result.imports).toEqual({
        "@hot-updater/server/runtime":
          "./_hot-updater/hot-updater-server/dist/runtime.mjs",
        "@hot-updater/supabase":
          "./_hot-updater/hot-updater-supabase/dist/edge.mjs",
        "@hot-updater/core": "./_hot-updater/hot-updater-core/dist/index.mjs",
        "@hot-updater/js": "./_hot-updater/hot-updater-js/dist/index.mjs",
        "@hot-updater/plugin-core":
          "./_hot-updater/hot-updater-plugin-core/dist/index.mjs",
        "@supabase/supabase-js": `npm:@supabase/supabase-js@${resolvePackageVersion(
          "@supabase/supabase-js",
          {
            searchFrom: path.resolve("plugins/supabase"),
          },
        )}`,
        "es-toolkit": `npm:es-toolkit@${resolvePackageVersion("es-toolkit", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
        mime: `npm:mime@${resolvePackageVersion("mime", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
        semver: `npm:semver@${resolvePackageVersion("semver", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
      });

      await expect(
        fs.readFile(
          path.join(
            targetDir,
            "_hot-updater/hot-updater-server/dist/runtime.mjs",
          ),
          "utf8",
        ),
      ).resolves.toContain("./handler.mjs");

      const supabaseDistFiles = await fs.readdir(
        path.join(targetDir, "_hot-updater/hot-updater-supabase/dist"),
      );
      expect(
        supabaseDistFiles.some(
          (file) =>
            file.startsWith("supabaseEdgeFunctionStorage-") &&
            file.endsWith(".mjs"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});

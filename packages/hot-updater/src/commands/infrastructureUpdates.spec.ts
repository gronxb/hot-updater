import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { UPDATE_TARGETS } from "./doctorInfrastructureTargets";
import { readInfrastructureUpgradeFiles } from "./infra/upgradeFiles";
import { INFRASTRUCTURE_UPDATES } from "./infrastructureUpdates";

const readUpdates = () =>
  readInfrastructureUpgradeFiles(
    path.resolve(import.meta.dirname, "../../infrastructure-upgrades"),
    INFRASTRUCTURE_UPDATES,
  );

describe("infrastructure upgrade requirements", () => {
  it("requires a complete version-named release file for every doctor requirement", async () => {
    expect(UPDATE_TARGETS).toBe(INFRASTRUCTURE_UPDATES);
    const files = await readUpdates();
    expect(files.map(({ file }) => file)).toEqual(
      UPDATE_TARGETS.map(({ version }) => `${version}.md`),
    );
  });

  it("links to the v0-to-v1 guide preserving cutover and provider reuse boundaries", async () => {
    const first = (await readUpdates())[0]!;
    expect(first.version).toBe("1.0.0");
    expect(first.content).toContain(
      "https://hot-updater.dev/docs/guides/upgrade-to-v1",
    );
    const guide = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../../docs/content/docs/(latest)/guides/upgrade-to-v1.mdx",
      ),
      "utf8",
    );
    expect(guide).toContain("no in-place v0 database or protocol upgrade");
    expect(guide).toContain("not backfilled");
    expect(guide).toMatch(
      /Do not deliver v1 `@hot-updater\/react-native` JavaScript to a v0 native binary/,
    );
    expect(guide).toMatch(
      /Firebase and Supabase can\s+reuse the existing project/,
    );
    expect(guide).toContain("separate D1");
    expect(guide).toContain("separate v1 DynamoDB");
  });
});

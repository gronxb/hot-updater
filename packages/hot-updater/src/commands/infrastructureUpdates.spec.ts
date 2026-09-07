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

  it("preserves the original v0-to-v1 cutover and provider reuse boundaries", async () => {
    const first = (await readUpdates())[0]!;
    expect(first.version).toBe("1.0.0");
    expect(first.content).toContain("cannot be upgraded in place");
    expect(first.content).toContain("not backfilled");
    expect(first.content).toMatch(
      /Do not deliver\s+v1 React Native SDK JavaScript to a v0 native binary/,
    );
    expect(first.content.match(/A v0 project can be reused/g)).toHaveLength(2);
    expect(first.content).toContain("separate D1");
    expect(first.content).toContain("separate DynamoDB");
  });
});

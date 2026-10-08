import fs from "fs/promises";
import path from "path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(__dirname, "../../..");
const read = (relativePath: string) =>
  fs.readFile(path.join(repoDir, relativePath), "utf8");

describe("E2E Remote Config lock", () => {
  it("lets one scenario at a time write a server's Remote Config", async () => {
    const controller = await read("e2e/shared/control-server/controller.ts");

    // One holder per server URL, across every control server on the machine.
    expect(controller).toContain("capacity: 1,");
    expect(controller).toContain("lockRoot: remoteConfigLockRoot(),");
    expect(controller).toContain(".update(getControllerReachableAppBaseUrl())");
    // Only a write to the database waits for the caches.
    expect(controller).toContain(
      "const result = await write(createRemoteConfigApiWriter(api));\n    await sleep(REMOTE_CONFIG_PROPAGATION_MS);",
    );
  });

  it("holds the lock from the first publish until the scenario ends", async () => {
    const scenario = await read(
      "e2e/shared/scenarios/remote-config-fetch-activate.ts",
    );
    const acquire = scenario.indexOf('"/e2e/jobs/acquire-remote-config-lock"');
    const firstPublish = scenario.indexOf('"/e2e/publish-remote-config"');
    const release = scenario.indexOf('"/e2e/release-remote-config-lock"');

    expect(acquire).toBeGreaterThan(-1);
    expect(acquire).toBeLessThan(firstPublish);
    expect(scenario.slice(acquire, release)).toContain("} finally {");
    expect(release).toBeGreaterThan(
      scenario.lastIndexOf("/e2e/rollback-remote-config"),
    );
  });
});

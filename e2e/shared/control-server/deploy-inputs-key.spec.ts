import { describe, expect, it } from "vitest";

import { createDeployInputsKey } from "./deploy-inputs-key.ts";

const mainDeploy = {
  appSource: 'export const E2E_SCENARIO_MARKER = "main";',
  appSourceFile: "examples/v0.85.0/src/e2eApp/patchSurface.ts",
  bundleProfile: "default",
  configSource: "build: bare({ enableHermes: true, resetCache: false })",
  marker: "main",
};

describe("deploy inputs key", () => {
  it("is shared by deploys that write the same inputs", () => {
    expect(createDeployInputsKey(mainDeploy)).toBe(
      createDeployInputsKey({ ...mainDeploy }),
    );
  });

  it("differs for any input a deploy writes", () => {
    const key = createDeployInputsKey(mainDeploy);
    for (const change of [
      // A widget deploy beside a main one.
      {
        appSourceFile: "examples/v0.85.0/src/widgetApp/patchSurface.ts",
        configSource:
          'build: bare({ enableHermes: true, resetCache: false, entryFile: "index.widget.js" })',
      },
      { appSource: 'export const E2E_SCENARIO_MARKER = "other";' },
      { bundleProfile: "assetHeavy" },
      { marker: "other" },
      { configSource: 'updateStrategy: "fingerprint"' },
    ]) {
      expect(createDeployInputsKey({ ...mainDeploy, ...change })).not.toBe(key);
    }
  });
});

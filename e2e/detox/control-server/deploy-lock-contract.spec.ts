import fs from "fs/promises";
import path from "path";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(__dirname, "../../..");
const controllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);

describe("Detox control-server deploy lock", () => {
  it("uses a defined process liveness helper for stale deploy lock owners", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).toContain(
      "function isProcessRunning(pid: number)",
    );
    expect(controllerSource).toContain("return isProcessRunning(owner.pid);");
  });
});

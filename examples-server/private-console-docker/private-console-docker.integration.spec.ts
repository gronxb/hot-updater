import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname);
const hasDockerCompose =
  spawnSync("docker", ["compose", "version", "--short"], {
    stdio: "ignore",
  }).status === 0;

describe("private console Docker example", () => {
  (hasDockerCompose ? it : it.skip)(
    "renders a valid Compose config with nginx auth in front of the console",
    async () => {
      const result = spawnSync("docker", ["compose", "config"], {
        cwd: projectRoot,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("console:");
      expect(result.stdout).toContain("nginx:");
      expect(result.stdout).toContain("/etc/nginx/.htpasswd");
      expect(result.stdout).toContain("HOT_UPDATER_CONFIG_PATH");
      expect(
        fs.readFileSync(path.join(projectRoot, "nginx.conf"), "utf8"),
      ).toContain("auth_basic_user_file");
    },
  );
});

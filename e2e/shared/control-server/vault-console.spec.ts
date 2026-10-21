import { describe, expect, it } from "vitest";

import {
  envFileNames,
  vaultDeployEnv,
  vaultTokenOf,
  withConsoleSigning,
} from "./vault-console.ts";

describe("vault console", () => {
  it("reads the one token secrets token create prints", () => {
    expect(
      vaultTokenOf(
        "│  Token:    hu_vault_ab-C_1\n▲  Save this token now, such as in CI's HOT_UPDATER_VAULT_TOKEN, and HOT_UPDATER_SIGNING_TOKEN for remoteSigning.",
      ),
    ).toBe("hu_vault_ab-C_1");
    expect(() => vaultTokenOf("Vault token created")).toThrow(
      "printed 0 vault tokens",
    );
  });

  it("names every variable an env file sets", () => {
    expect(
      envFileNames(
        [
          "# storage",
          'AWS_ACCESS_KEY_ID="local"',
          "export HOT_UPDATER_ADMIN_TOKEN=secret # admin",
          "  AWS_REGION = us-east-1",
          "not a variable",
          "AWS_REGION=us-west-2",
        ].join("\n"),
      ),
    ).toEqual(["AWS_ACCESS_KEY_ID", "HOT_UPDATER_ADMIN_TOKEN", "AWS_REGION"]);
  });

  it("signs with remoteSigning at the console instead of the local key", () => {
    const source = [
      'import { defineConfig } from "hot-updater";',
      "export default defineConfig({",
      '  updateStrategy: "appVersion",',
      "  signing: {",
      "    enabled: true,",
      '    privateKeyPath: "./keys/private-key.pem",',
      "  },",
      "});",
    ].join("\n");

    const signed = withConsoleSigning(source, "http://127.0.0.1:4100");

    expect(signed).toContain(
      'import { remoteSigning } from "hot-updater/signing";',
    );
    expect(signed).toContain(
      'signing: remoteSigning({ endpoint: "http://127.0.0.1:4100" })',
    );
    expect(signed).not.toContain("privateKeyPath");
  });

  it("refuses a config whose signing it cannot replace exactly once", () => {
    expect(() =>
      withConsoleSigning("export default {};", "http://127.0.0.1:4100"),
    ).toThrow("sets signing as an object literal 0 times");
    expect(() =>
      withConsoleSigning(
        "signing: { enabled: true }, nativeBuild: { signing: { keystore: 'k' } }",
        "http://127.0.0.1:4100",
      ),
    ).toThrow("sets signing as an object literal 2 times");
  });

  it("deploys with the connection alone, without the env file's variables", () => {
    const env = vaultDeployEnv(
      {
        AWS_SECRET_ACCESS_KEY: "from the profile",
        HOT_UPDATER_ADMIN_TOKEN: "admin",
        HOT_UPDATER_VAULT_MASTER_KEY: "never in a deploy",
        PATH: "/usr/bin",
      },
      "AWS_SECRET_ACCESS_KEY=secret\nHOT_UPDATER_ADMIN_TOKEN=admin\n",
      { url: "http://127.0.0.1:4100", deployToken: "hu_vault_deploy" },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOT_UPDATER_CONSOLE_URL: "http://127.0.0.1:4100",
      HOT_UPDATER_VAULT_TOKEN: "hu_vault_deploy",
      HOT_UPDATER_SIGNING_TOKEN: "hu_vault_deploy",
    });
  });
});

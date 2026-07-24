import { HOT_UPDATER_API_KEY_ENV_NAME } from "@hot-updater/api-key/provisioning";
import { describe, expect, it } from "vitest";

import { getConfigScaffold, SOURCE_TEMPLATE } from "./templates";

describe("AWS managed config scaffold", () => {
  it("renders access key credentials for account mode", () => {
    const scaffold = getConfigScaffold("bare", { mode: "account" });

    expect(scaffold.text).toContain(
      "accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!",
    );
    expect(scaffold.text).toContain(
      "secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!",
    );
    expect(scaffold.text).not.toContain("fromSSO(");
    expect(scaffold.text).not.toContain("fromIni(");
    expect(scaffold.text).not.toContain("fromNodeProviderChain(");
  });

  it("renders SSO credentials for sso mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "sso",
      profile: "default",
    });

    expect(scaffold.text).toContain(
      'import { fromSSO } from "@aws-sdk/credential-provider-sso";',
    );
    expect(scaffold.text).toContain(
      "credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });

  it("renders the default provider chain for local session mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    expect(scaffold.text).toContain(
      'import { fromNodeProviderChain } from "@aws-sdk/credential-providers";',
    );
    expect(scaffold.text).toContain("credentials: fromNodeProviderChain()");
    expect(scaffold.text).not.toContain("HOT_UPDATER_S3_ACCESS_KEY_ID");
  });

  it("renders a shared profile lookup for local profile mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: "work",
    });

    expect(scaffold.text).toContain(
      'import { fromIni } from "@aws-sdk/credential-providers";',
    );
    expect(scaffold.text).toContain(
      "credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });

  it("wires the provisioned client key into update-check request headers", () => {
    // Given: initialization renders the React Native source template.
    // When: its machine-consumed updater options are inspected.
    // Then: the managed endpoint receives the provisioned API key.
    expect(SOURCE_TEMPLATE).toContain("requestHeaders:");
    expect(SOURCE_TEMPLATE).toContain('"x-api-key"');
    expect(SOURCE_TEMPLATE).toContain(
      `process.env.${HOT_UPDATER_API_KEY_ENV_NAME}!`,
    );
  });
});

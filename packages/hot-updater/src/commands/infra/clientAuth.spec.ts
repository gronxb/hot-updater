import { describe, expect, it } from "vitest";

import { renderAgentInstructions, type InfraClientAuth } from "./clientAuth";

const apiKey: InfraClientAuth = {
  plugin: "apiKeys",
  varyHeaders: ["x-api-key"],
  credential: {
    label: "API key",
    header: "x-api-key",
    env: "HOT_UPDATER_API_KEY",
  },
};

const text = [
  "Deploy the server.",
  "<!-- if credential -->",
  "Send the {{CREDENTIAL_LABEL}} in `{{CREDENTIAL_HEADER}}` from {{CREDENTIAL_ENV}}.",
  "<!-- else -->",
  "Client routes are public.",
  "<!-- end -->",
  "Verify it.",
].join("\n");

describe("renderAgentInstructions", () => {
  it("keeps the credential steps when the server takes one", () => {
    expect(renderAgentInstructions(text, apiKey)).toBe(
      [
        "Deploy the server.",
        "Send the API key in `x-api-key` from HOT_UPDATER_API_KEY.",
        "Verify it.",
      ].join("\n"),
    );
  });

  it("keeps the public steps when client routes are public", () => {
    expect(renderAgentInstructions(text, null)).toBe(
      ["Deploy the server.", "Client routes are public.", "Verify it."].join(
        "\n",
      ),
    );
  });

  it.each([
    ["{{CREDENTIAL_ENV}}", "{{CREDENTIAL_ENV}} appears outside"],
    ["<!-- if credential -->\n<!-- if credential -->", "Nested"],
    ["<!-- else -->", "Unexpected else"],
    ["<!-- end -->", "Unexpected end"],
    ["<!-- if credential -->", "Unclosed"],
  ])("refuses malformed instructions: %s", (source, message) => {
    expect(() => renderAgentInstructions(source, null)).toThrow(message);
  });
});

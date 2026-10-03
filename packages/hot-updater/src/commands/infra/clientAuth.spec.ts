import { describe, expect, it } from "vitest";

import {
  renderAgentInstructions,
  type InfraClientAuth,
  type InfraClientPlugin,
} from "./clientAuth";

const apiKey: InfraClientAuth = {
  plugin: "apiKeys",
  varyHeaders: ["x-api-key"],
  credential: {
    label: "API key",
    header: "x-api-key",
    env: "HOT_UPDATER_API_KEY",
  },
};

const insights: InfraClientPlugin = {
  module: "@hot-updater/react-native",
  name: "insights",
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

const app = [
  "<!-- if clientPlugins -->",
  "Add {{CLIENT_PLUGIN_LIST}} once.",
  "<!-- end -->",
  "```ts",
  "{{APP_IMPORTS}}",
  "",
  "HotUpdater.init({",
  '  baseURL: "<verified-base-url>",',
  "  plugins: [{{CLIENT_PLUGINS}}],",
  "});",
  "```",
].join("\n");

describe("renderAgentInstructions", () => {
  it("keeps the credential steps when the server takes one", () => {
    expect(
      renderAgentInstructions(text, { clientAuth: apiKey, clientPlugins: [] }),
    ).toBe(
      [
        "Deploy the server.",
        "Send the API key in `x-api-key` from HOT_UPDATER_API_KEY.",
        "Verify it.",
      ].join("\n"),
    );
  });

  it("keeps the public steps when client routes are public", () => {
    expect(
      renderAgentInstructions(text, { clientAuth: null, clientPlugins: [] }),
    ).toBe(
      ["Deploy the server.", "Client routes are public.", "Verify it."].join(
        "\n",
      ),
    );
  });

  it("names and adds the client plugins the server's plugins ask for", () => {
    const feedback = { module: "feedback-rn", name: "feedback" };
    expect(
      renderAgentInstructions(app, {
        sdkModule: "@hot-updater/react-native",
        clientAuth: null,
        clientPlugins: [insights, feedback],
      }),
    ).toBe(
      [
        "Add `insights()` from `@hot-updater/react-native`, `feedback()` from `feedback-rn` once.",
        "```ts",
        'import { HotUpdater, insights } from "@hot-updater/react-native";',
        'import { feedback } from "feedback-rn";',
        "",
        "HotUpdater.init({",
        '  baseURL: "<verified-base-url>",',
        "  plugins: [insights(), feedback()],",
        "});",
        "```",
      ].join("\n"),
    );
  });

  it("inserts names as they are, `$` included", () => {
    const dollars = { module: "feedback-rn", name: "$$fb" };
    const rendered = renderAgentInstructions(app, {
      clientAuth: null,
      clientPlugins: [dollars],
    });
    expect(rendered).toContain('import { $$fb } from "feedback-rn";');
    expect(rendered).toContain("  plugins: [$$fb()],");
    expect(rendered).toContain("Add `$$fb()` from `feedback-rn` once.");
  });

  it("leaves out the client plugin lines when there are none", () => {
    expect(
      renderAgentInstructions(app, { clientAuth: null, clientPlugins: [] }),
    ).toBe(
      [
        "```ts",
        "// Import HotUpdater from your application integration.",
        "",
        "HotUpdater.init({",
        '  baseURL: "<verified-base-url>",',
        "});",
        "```",
      ].join("\n"),
    );
  });

  it.each([
    ["{{CREDENTIAL_ENV}}", "{{CREDENTIAL_ENV}} appears outside"],
    ["{{CLIENT_PLUGIN_LIST}}", "{{CLIENT_PLUGIN_LIST}} appears outside"],
    ["<!-- if credential -->\n<!-- if clientPlugins -->", "Nested"],
    ["<!-- if server -->", 'Unknown condition "server"'],
    ["<!-- else -->", "Unexpected else"],
    ["<!-- end -->", "Unexpected end"],
    ["<!-- if credential -->", "Unclosed"],
  ])("refuses malformed instructions: %s", (source, message) => {
    expect(() =>
      renderAgentInstructions(source, { clientAuth: null, clientPlugins: [] }),
    ).toThrow(message);
  });
});

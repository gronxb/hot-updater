import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { transformClientAccess } from "./clientAccess";

const fixturesDirectory = path.join(
  __dirname,
  "__testfixtures__",
  "client-access",
);
const inputs = readdirSync(fixturesDirectory)
  .filter((name) => name.includes(".input."))
  .sort();

/** A fixture's input and the output it rewrites to; no output file means unchanged. */
const readFixture = (inputName: string) => {
  const input = readFileSync(path.join(fixturesDirectory, inputName), "utf-8");
  const outputPath = path.join(
    fixturesDirectory,
    inputName.replace(".input.", ".output."),
  );
  return {
    input,
    output: existsSync(outputPath) ? readFileSync(outputPath, "utf-8") : input,
  };
};

const SERVER_IMPORT = 'import { createHotUpdater } from "@hot-updater/server";';

describe("client-access codemod fixtures", () => {
  it.each(inputs)("rewrites %s", (inputName) => {
    // Given a server file from before 1.0, or one already migrated
    const { input, output } = readFixture(inputName);

    // When the codemod runs on it, and again on its result
    const result = transformClientAccess(input, inputName);
    const rerun = transformClientAccess(result.text, inputName);

    // Then it matches the expected output and a second run changes nothing
    expect(result).toEqual({ text: output, issues: [] });
    expect(rerun).toEqual({ text: output, issues: [] });
  });

  it.each(inputs)("keeps CRLF line breaks in %s", (inputName) => {
    const { input, output } = readFixture(inputName);
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");

    expect(transformClientAccess(crlf(input), inputName)).toEqual({
      text: crlf(output),
      issues: [],
    });
  });
});

describe("client-access codemod reports", () => {
  it.each([
    {
      name: "a clientAccess that is not a literal",
      body: "export const hotUpdater = createHotUpdater({\n  database,\n  clientAccess: access,\n});",
      line: 4,
      column: 3,
      message: "clientAccess is not a literal",
    },
    {
      name: "a clientAccess object with an unknown option",
      body: 'export const hotUpdater = createHotUpdater({\n  database,\n  clientAccess: { type: "api-key", cache: true },\n});',
      line: 4,
      column: 3,
      message: 'clientAccess is not { type: "public" }',
    },
    {
      name: "a clientAccess string that is not a policy",
      body: 'export const hotUpdater = createHotUpdater({ database, clientAccess: "api-key" });',
      line: 2,
      column: 70,
      message: 'clientAccess: "api-key" is not a policy',
    },
    {
      name: "options that spread another object",
      body: 'export const hotUpdater = createHotUpdater({\n  ...shared,\n  clientAccess: { type: "public" },\n});',
      line: 3,
      column: 3,
      message: "spread another object",
    },
    {
      name: "options that are not an object literal",
      body: "export const hotUpdater = createHotUpdater(options);",
      line: 2,
      column: 27,
      message: "options are not an object literal",
    },
    {
      name: "a plugins list that is not an array literal",
      body: 'export const hotUpdater = createHotUpdater({\n  database,\n  plugins: sharedPlugins,\n  clientAccess: { type: "api-key" },\n});',
      line: 4,
      column: 3,
      message: "plugins is not an array literal",
    },
    {
      name: "a plugins list with a spread",
      body: 'export const hotUpdater = createHotUpdater({\n  database,\n  plugins: [...sharedPlugins],\n  clientAccess: { type: "api-key" },\n});',
      line: 4,
      column: 3,
      message: "plugins is not an array literal",
    },
    {
      name: "a plugins list that already has apiKeys()",
      body: 'export const hotUpdater = createHotUpdater({\n  database,\n  plugins: [apiKeys()],\n  clientAccess: { type: "api-key" },\n});',
      line: 5,
      column: 3,
      message: "plugins already has apiKeys()",
    },
    {
      name: "a call with neither clientAccess nor plugins",
      body: "export const hotUpdater = createHotUpdater({ database });",
      line: 2,
      column: 27,
      message: "neither clientAccess nor plugins",
    },
    {
      name: "a plugin name the file already declares",
      body: 'const insights = () => [];\nexport const hotUpdater = createHotUpdater({\n  database,\n  clientAccess: { type: "public" },\n});',
      line: 3,
      column: 27,
      message: "insights is already declared in this file",
    },
  ])("reports $name and leaves the file unchanged", (fixture) => {
    // Given a call the codemod cannot rewrite safely
    const source = `${SERVER_IMPORT}\n${fixture.body}\n`;

    // When the codemod runs
    const result = transformClientAccess(source, "server.ts");

    // Then the call is reported where it is, and nothing changes
    expect(result.text).toBe(source);
    expect(result.issues).toEqual([
      {
        line: fixture.line,
        column: fixture.column,
        message: expect.stringContaining(fixture.message),
      },
    ]);
  });

  it("leaves every call alone when one call in the file is reported", () => {
    const source = [
      SERVER_IMPORT,
      'export const a = createHotUpdater({ database, clientAccess: { type: "public" } });',
      "export const b = createHotUpdater({ database, clientAccess: access });",
      "",
    ].join("\n");

    const result = transformClientAccess(source, "server.ts");

    expect(result.text).toBe(source);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 3 });
  });

  it("reports a file it cannot parse", () => {
    const source = `${SERVER_IMPORT}\nexport const hotUpdater = createHotUpdater({\n`;

    const result = transformClientAccess(source, "server.ts");

    expect(result.text).toBe(source);
    expect(result.issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Could not parse this file"),
      }),
    ]);
  });

  it("ignores files that do not import createHotUpdater from the server", () => {
    const source =
      'export const hotUpdater = createHotUpdater({ clientAccess: { type: "public" } });\n';

    expect(transformClientAccess(source, "server.ts")).toEqual({
      text: source,
      issues: [],
    });
  });
});

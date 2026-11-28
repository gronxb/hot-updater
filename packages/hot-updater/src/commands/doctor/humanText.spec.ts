import { describe, expect, it } from "vitest";

import { humanText, unusedSecretsText } from "./humanText";
import { foreignPluginsNote, replayLead } from "./managed";

describe("humanText", () => {
  it("shortens init's lead", () => {
    expect(humanText(replayLead({ source: "environment" } as never))).toBe(
      "Upgrade with init's saved inputs as <env file>:",
    );
  });

  it("drops why a server must change with the migration", () => {
    expect(
      humanText(
        "In the server's project, run `npx hot-updater db migrate <server file>`: it creates the missing tables. A server of an earlier release answers 503 once the database is migrated, and a server of this release answers 503 until it is.",
      ),
    ).toBe(
      "In the server's project, run `npx hot-updater db migrate <server file>`: it creates the missing tables.",
    );
  });

  it("keeps the deployment's first step, and the name of what init would drop", () => {
    expect(
      humanText(
        foreignPluginsNote({
          foreignPlugins: ["audit"],
          server: "the Cloudflare Worker",
        } as never)!,
      ),
    ).toBe(
      "hot-updater.config.ts lists a plugin the managed server does not run (audit), and init would drop it. Remove it from plugins, or, if a server of your own runs it on this database:",
    );
  });

  it("keeps text it has nothing to say about", () => {
    const text =
      "Could not check the release catalogs: 401 Authentication error";
    expect(humanText(text)).toBe(text);
  });
});

describe("unusedSecretsText", () => {
  const message = [
    "a and b aren't in the team secrets adapter.",
    "No build or deploy reads them yet, so nothing fails.",
  ].join("\n");

  it("prints one command for names that take the same action", () => {
    expect(
      unusedSecretsText({
        names: ["a", "b"],
        message,
        resolution: [
          "Store them before a build or a deploy reads them:",
          "npx hot-updater secrets put a --kind android-keystore <upload.jks>",
          "npx hot-updater secrets put b --kind android-keystore <upload.jks>",
        ].join("\n"),
      }).split("\n"),
    ).toEqual([
      "a and b aren't in the team secrets adapter.",
      "No build or deploy reads them yet.",
      "npx hot-updater secrets put <name> --kind android-keystore <upload.jks>",
    ]);
  });

  it("keeps each command when they differ", () => {
    expect(
      unusedSecretsText({
        names: ["a", "b"],
        message,
        resolution: [
          "Store them before a build or a deploy reads them:",
          "npx hot-updater secrets issue asc-api-key a",
          "npx hot-updater secrets put b --kind android-keystore <upload.jks>",
        ].join("\n"),
      })
        .split("\n")
        .slice(2),
    ).toEqual([
      "npx hot-updater secrets issue asc-api-key a",
      "npx hot-updater secrets put b --kind android-keystore <upload.jks>",
    ]);
  });
});

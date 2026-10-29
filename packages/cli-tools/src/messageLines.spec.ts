import { describe, expect, it } from "vitest";

import { describeMissingSecret } from "./credentialResolver";
import { fitMessage } from "./messageLines";
import { localSecrets } from "./secrets";

/** The lines wider than 76 columns that a space could have broken. */
const tooWide = (message: string) =>
  message.split("\n").filter((line) => line.length > 76 && line.includes(" "));

describe("fitMessage", () => {
  it("breaks a long line at spaces and keeps lines that fit as they are", () => {
    expect(
      fitMessage([
        "  npx hot-updater secrets put release-keystore",
        `The git repository /Users/someone/projects/${"a".repeat(50)}/app doesn't ignore it.`,
      ]).split("\n"),
    ).toEqual([
      "  npx hot-updater secrets put release-keystore",
      "The git repository",
      `/Users/someone/projects/${"a".repeat(50)}/app`,
      "doesn't ignore it.",
    ]);
  });

  it("gives a URL longer than a line a line of its own: it can't be broken", () => {
    const url = `https://hot-updater.dev/docs/guides/secrets-adapters/${"x".repeat(40)}`;

    expect(fitMessage([`Read ${url} first.`]).split("\n")).toEqual([
      "Read",
      url,
      "first.",
    ]);
  });
});

describe("describeMissingSecret", () => {
  const command =
    "npx hot-updater secrets put a-very-long-upload-keystore-name";

  it("fits a long name and adapter", () => {
    const team = {
      name: "a-team-secrets-adapter-with-a-long-name",
      get: async () => ({}),
      set: async () => {},
    };
    const name = "codex-relay-android-release-upload-keystore";

    for (const secrets of [team, localSecrets()]) {
      const message = describeMissingSecret(secrets, name, { command });
      expect(tooWide(message)).toEqual([]);
      expect(message.split("\n").at(-1)).toBe(command);
    }
  });
});

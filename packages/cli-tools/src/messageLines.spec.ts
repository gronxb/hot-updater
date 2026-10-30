import { describe, expect, it } from "vitest";

import { describeMissingSecret } from "./credentialResolver";
import { displayWidth, fitMessage, MESSAGE_WIDTH } from "./messageLines";
import { localSecrets } from "./secrets";

/** The lines wider than 73 columns, 76 after clack's gutter, that a space could have broken. */
const tooWide = (message: string) =>
  message
    .split("\n")
    .filter((line) => displayWidth(line) > 73 && line.includes(" "));

describe("displayWidth", () => {
  it("counts the columns a terminal shows, not bytes or code units", () => {
    // Several bytes each, one column each.
    expect(displayWidth("│  ■ …")).toBe(6);
    expect(Buffer.byteLength("│  ■ …")).toBe(12);
    // Wide characters and emoji take two; a combining mark none.
    expect(displayWidth("키 🔑")).toBe(5);
    expect(displayWidth("e\u0301")).toBe(1);
    // Colors take none.
    expect(displayWidth("\u001b[32mok\u001b[39m")).toBe(2);
  });
});

describe("fitMessage", () => {
  it("keeps each line within 76 columns after clack's 3-column gutter", () => {
    expect(MESSAGE_WIDTH + "│  ".length).toBe(76);
    const words = Array.from({ length: 40 }, (_, index) => `프로젝트${index}`);

    const lines = fitMessage([words.join(" ")]).split("\n");

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(`│  ${line}`)).toBeLessThanOrEqual(76);
    }
  });

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
    const url = `https://example.com/a-very-long-path/${"x".repeat(60)}`;

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

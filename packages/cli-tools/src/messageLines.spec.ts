import { describe, expect, it } from "vitest";

import { describeMissingSecret } from "./credentialResolver";
import {
  displayWidth,
  fitMessage,
  fitText,
  formatCommand,
  MESSAGE_WIDTH,
  withProviderMessages,
} from "./messageLines";
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

describe("formatCommand", () => {
  it("counts the ` \\` it adds toward the width", () => {
    // 72 columns before the ` \\`, which would make 74.
    expect(
      formatCommand(
        "npx hot-updater secrets put qa-missing-signing --kind bundle-signing-key <key.pem>",
      ).split("\n"),
    ).toEqual([
      "npx hot-updater secrets put qa-missing-signing --kind \\",
      "  bundle-signing-key <key.pem>",
    ]);
  });

  it("fills a line to the width with its last word, which needs no ` \\`", () => {
    const fits = `npx ${"a".repeat(MESSAGE_WIDTH - 4 - "<b>".length - 1)} <b>`;
    expect(displayWidth(fits)).toBe(MESSAGE_WIDTH);
    expect(formatCommand(fits)).toBe(fits);
  });

  it("keeps a placeholder whole", () => {
    expect(
      formatCommand(
        "npx hot-updater init --provider aws --build bare --from-env-file <env file>",
      ).split("\n"),
    ).toEqual([
      "npx hot-updater init --provider aws --build bare --from-env-file \\",
      "  <env file>",
    ]);
  });
});

describe("fitText", () => {
  it("breaks prose at spaces within the width, as doctor's resolution", () => {
    expect(
      fitText(
        "Run npx hot-updater keys remove to remove public keys, or enable signing in hot-updater.config.ts",
      )
        .split("\n")
        .map(displayWidth),
    ).toEqual([72, 24]);
  });

  it("breaks a command with ` \\` and a continued line without another indent", () => {
    expect(
      fitText(
        [
          "Store it:",
          `  npx hot-updater secrets put ${"a".repeat(40)} --kind android-keystore \\`,
          `    ${"b".repeat(30)} ${"c".repeat(50)}`,
        ].join("\n"),
      ).split("\n"),
    ).toEqual([
      "Store it:",
      `  npx hot-updater secrets put ${"a".repeat(40)} \\`,
      "    --kind android-keystore \\",
      `    ${"b".repeat(30)} \\`,
      `    ${"c".repeat(50)}`,
    ]);
  });

  it("gives a URL or a path a line of its own, the one line that may be wider", () => {
    const url = `https://example.com/${"x".repeat(80)}`;
    expect(fitText(`Guide: ${url} now`).split("\n")).toEqual([
      "Guide:",
      url,
      "now",
    ]);
  });

  it("counts wide characters and emoji as two columns", () => {
    const lines = fitText(`🔑 ${"키값 ".repeat(30)}`).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(MESSAGE_WIDTH);
    }
    // 37 wide characters take 74 columns, though `.length` says 37.
    expect(fitText(`${"키".repeat(36)} 키`).split("\n")).toHaveLength(2);
  });

  it("ignores colors in the width and closes them at each line's end", () => {
    const green = (text: string) => `\u001B[32m${text}\u001B[39m`;
    const fits = green("a".repeat(MESSAGE_WIDTH));
    expect(fitText(fits)).toBe(fits);

    const lines = fitText(green(`${"word ".repeat(30).trim()}`)).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("\u001B[32m")).toBe(true);
      expect(line.endsWith("\u001B[39m")).toBe(true);
      expect(displayWidth(line)).toBeLessThanOrEqual(MESSAGE_WIDTH);
    }
  });

  it("changes nothing when fitted twice", () => {
    const text = [
      `npx hot-updater secrets put ${"a".repeat(40)} --kind android-keystore <upload.jks>`,
      "word ".repeat(40).trim(),
      `https://example.com/${"x".repeat(80)}`,
    ].join("\n");
    expect(fitText(fitText(text))).toBe(fitText(text));
  });

  it("keeps blank lines", () => {
    expect(fitText("a\n\nb")).toBe("a\n\nb");
  });
});

describe("withProviderMessages", () => {
  it("shows Cloudflare's errors[].message, not its JSON", () => {
    // As the Cloudflare SDK's APIError builds its message: `${status} ${body}`.
    expect(
      withProviderMessages(
        'Could not check the release catalogs: 401 {"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}',
      ),
    ).toBe("Could not check the release catalogs: 401 Authentication error");
    expect(
      withProviderMessages(
        '403 {"success":false,"errors":[{"code":1,"message":"One"},{"code":2,"message":"Two"},{"code":3,"message":"One"}]}',
      ),
    ).toBe("403 One; Two");
  });

  it.each([
    ['{"message":"Bad token"}', "Bad token"],
    ['{"error":"invalid_grant"}', "invalid_grant"],
    [
      '{"error":"invalid_grant","error_description":"Token expired"}',
      "Token expired",
    ],
    ['{"error":{"code":403,"message":"Denied","status":"X"}}', "Denied"],
    ['[{"message":"First"},{"message":"Second"}]', "First; Second"],
    ['{\n  "message": "Pretty"\n}', "Pretty"],
  ])("reads %s", (body, message) => {
    expect(withProviderMessages(`Failed: ${body}`)).toBe(`Failed: ${message}`);
  });

  it("caps a long message at two lines", () => {
    const message = withProviderMessages(
      JSON.stringify({ message: `Denied ${"word ".repeat(200)}` }),
    );
    expect(displayWidth(message)).toBeLessThanOrEqual(MESSAGE_WIDTH * 2);
    expect(message.endsWith("…")).toBe(true);
  });

  it("cuts a body that says no message", () => {
    const message = withProviderMessages(
      `500 ${JSON.stringify({ result: "x".repeat(200) })}`,
    );
    expect(displayWidth(message)).toBeLessThanOrEqual(44);
  });

  it.each([
    "No JSON here.",
    "[ERROR] Failed at {name}.",
    'Pass ["ios","android"] or {} here',
    "unbalanced { brace and [ bracket",
  ])("leaves %s as it is", (text) => {
    expect(withProviderMessages(text)).toBe(text);
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

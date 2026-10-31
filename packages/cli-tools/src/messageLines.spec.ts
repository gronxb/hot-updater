import { describe, expect, it } from "vitest";

import {
  displayWidth,
  fitText,
  isCommandLine,
  MESSAGE_WIDTH,
  withProviderMessages,
} from "./messageLines";

describe("displayWidth", () => {
  it("counts the columns a terminal shows, not bytes or code units", () => {
    expect(displayWidth("│  ■ …")).toBe(6);
    expect(displayWidth("키 🔑")).toBe(5);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("\u001b[32mok\u001b[39m")).toBe(2);
  });
});

describe("fitText", () => {
  it("wraps prose at word boundaries", () => {
    const lines = fitText(
      "Run keys remove to remove public keys, or enable signing in hot-updater.config.ts",
    ).split("\n");
    expect(lines).toEqual([
      "Run keys remove to remove public keys, or enable signing in",
      "hot-updater.config.ts",
    ]);
  });

  it("wraps by display width, so wide characters take two columns", () => {
    const lines = fitText("프로젝트 ".repeat(30).trim()).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(MESSAGE_WIDTH);
    }
  });

  it.each([
    "npx hot-updater secrets put qa-missing-signing --kind bundle-signing-key <key.pem>",
    "  npx hot-updater init --provider cloudflare --build expo --from-env-file <env file>",
    `aws secretsmanager restore-secret --secret-id ${"a".repeat(80)}`,
    `az keyvault secret recover --vault-name vault --name ${"a".repeat(80)}`,
    `\u001B[32mnpx hot-updater secrets put ${"a".repeat(80)} <file>\u001B[39m`,
  ])("leaves the command %s whole", (command) => {
    expect(isCommandLine(command)).toBe(true);
    expect(fitText(command)).toBe(command);
  });

  it("doesn't take prose that starts with a tool's name for a command", () => {
    const prose = `aws CLI not found: ${"word ".repeat(30).trim()}`;
    expect(isCommandLine(prose)).toBe(false);
    expect(fitText(prose).split("\n").length).toBeGreaterThan(1);
  });

  it("gives a URL or a path a line of its own, whole", () => {
    const url = `https://example.com/${"x".repeat(80)}`;
    expect(fitText(`Guide: ${url} now`).split("\n")).toEqual([
      "Guide:",
      url,
      "now",
    ]);
  });

  it("leaves a table's rows whole", () => {
    const row = `│ ${"a".repeat(50)} │ ${"word ".repeat(10).trim()} │`;
    expect(fitText(row)).toBe(row);
  });

  it("closes a color at each line's end and reopens it on the next", () => {
    const lines = fitText(
      `\u001B[32m${"word ".repeat(30).trim()}\u001B[39m`,
    ).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith("\u001B[32m")).toBe(true);
      expect(line.endsWith("\u001B[39m")).toBe(true);
    }
  });

  it("changes nothing when fitted twice, and keeps blank lines", () => {
    const text = `${"word ".repeat(40).trim()}\n\nnpx hot-updater ${"a".repeat(80)}`;
    expect(fitText(fitText(text))).toBe(fitText(text));
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

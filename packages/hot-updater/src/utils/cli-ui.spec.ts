import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { ui } from "./cli-ui";

const plain = (text: string) => stripVTControlCharacters(text).split("\n");

describe("ui.commandLines", () => {
  it("breaks a long command at spaces, never inside a placeholder", () => {
    expect(
      plain(
        ui.commandLines(
          "npx hot-updater init --provider aws --build bare --from-env-file <env file>",
        ),
      ),
    ).toEqual([
      "npx hot-updater init --provider aws --build bare --from-env-file \\",
      "  <env file>",
    ]);
  });

  it("keeps a lone < as a word of its own", () => {
    expect(plain(ui.commandLines("cmd < /dev/null"))).toEqual([
      "cmd < /dev/null",
    ]);
  });
});

describe("ui.prose", () => {
  it("ends a command too long for a line with the punctuation after it", () => {
    expect(
      plain(
        ui.prose(
          "Run `npx hot-updater init --provider cloudflare --build expo --from-env-file <env file>`. Then check again.",
        ),
      ),
    ).toEqual([
      "Run",
      "npx hot-updater init --provider cloudflare --build expo --from-env-file \\",
      "  <env file>.",
      "Then check again.",
    ]);
  });
});

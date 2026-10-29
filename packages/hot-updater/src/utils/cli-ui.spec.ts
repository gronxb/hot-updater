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
  it("keeps the lines of text already laid out, with their indentation", () => {
    expect(
      plain(
        ui.prose(
          [
            "infisical() found no Infisical sign-in. Set one of:",
            "- INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
            "  with INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
          ].join("\n"),
        ),
      ),
    ).toEqual([
      "infisical() found no Infisical sign-in. Set one of:",
      "- INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
      "  with INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    ]);
  });

  it("keeps a command line and its continuations whole, and breaks one too wide as a command", () => {
    expect(
      plain(
        ui.prose(
          [
            "Check the name and your access, or import your key:",
            "npx hot-updater secrets put release-keystore --kind android-keystore \\",
            "  <upload.jks>",
          ].join("\n"),
        ),
      ),
    ).toEqual([
      "Check the name and your access, or import your key:",
      "npx hot-updater secrets put release-keystore --kind android-keystore \\",
      "  <upload.jks>",
    ]);
    expect(
      plain(
        ui.prose(
          "Import it:\nnpx hot-updater secrets put release-keystore --kind android-keystore <upload.jks>",
        ),
      ),
    ).toEqual([
      "Import it:",
      "npx hot-updater secrets put release-keystore --kind android-keystore \\",
      "  <upload.jks>",
    ]);
  });

  it("still shows a `command` in a laid-out line without its backticks", () => {
    expect(
      plain(
        ui.prose(
          "GitHub answered 403 to sign in.\nGive the job `permissions: id-token: write`.",
        ),
      ),
    ).toEqual([
      "GitHub answered 403 to sign in.",
      "Give the job permissions: id-token: write.",
    ]);
  });

  it("breaks a laid-out line too wide at spaces", () => {
    const lines = plain(
      ui.prose(
        `Couldn't read the infisical secrets adapter.\n${"word ".repeat(30).trim()}`,
      ),
    );
    expect(lines[0]).toBe("Couldn't read the infisical secrets adapter.");
    expect(lines.slice(1).every((line) => line.length <= 77)).toBe(true);
    expect(lines.slice(1).join(" ")).toBe("word ".repeat(30).trim());
  });

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

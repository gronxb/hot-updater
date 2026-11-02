import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { ui } from "./cli-ui";

const plain = (text: string) => stripVTControlCharacters(text).split("\n");

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

  it("keeps a command whole on its line, however long", () => {
    const command =
      "npx hot-updater secrets put release-keystore --kind android-keystore <upload.jks>";
    expect(plain(ui.prose(`Import it:\n${command}`))).toEqual([
      "Import it:",
      command,
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
      "npx hot-updater init --provider cloudflare --build expo --from-env-file <env file>.",
      "Then check again.",
    ]);
  });
});

describe("ui.source", () => {
  it("keeps an adapter's description whole, with its name", () => {
    const description =
      'the secret "hot-updater-asc-api-key" in Azure Key Vault (https://hu-qa-083aba.vault.azure.net)';

    expect(ui.source(description)).toBe(description);
  });

  it("shows a file as fitPath does", () => {
    const file = path.join(
      path.parse(process.cwd()).root,
      "a-long-directory-name".repeat(8),
      "secret.json",
    );

    expect(ui.source(file)).toBe(ui.fitPath(file));
    expect(ui.source(file)).toContain("…");
  });
});

import { stripVTControlCharacters } from "node:util";

import {
  credentialPutCommand,
  describeMissingSecret,
  displayWidth,
  localSecrets,
  p,
} from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { missingUnusedIssue } from "./commands/doctor/secrets";
import { releaseCatalogsUnchecked } from "./commands/doctor/serverData";
import { ui } from "./utils/cli-ui";
import { reportUnexpectedError } from "./utils/reportUnexpectedError";
import { reportSigningRefusal } from "./utils/signing/signingRefusal";

describe("the lines of what commands refuse, through the real printer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What `print` writes, each line at most 76 columns but for one word. */
  const printedLines = async (print: () => void | Promise<void>) => {
    let text = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      text += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    await print();
    vi.restoreAllMocks();
    expect(text).not.toBe("");
    return stripVTControlCharacters(text).split("\n");
  };

  const CLOUDFLARE_401 =
    '401 {"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}';
  const NAME = "codex-relay-android-release-upload-keystore";
  const COMMAND = `npx hot-updater secrets put ${NAME} --kind bundle-signing-key <key.pem>`;

  it.each<[string, () => void]>([
    [
      "doctor's unused secret",
      () => {
        const issue = missingUnusedIssue(
          [{ name: "qa-missing-signing", command: COMMAND }],
          "a-team-secrets-adapter-with-a-long-name",
        )!;
        p.log.warn(`${issue.message}\n${issue.resolution}`);
      },
    ],
    [
      "doctor's native warning",
      () => {
        p.log.warn(
          ui.prose(
            "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
          ),
        );
      },
    ],
    [
      "doctor's release catalogs",
      () => {
        const [issue] = releaseCatalogsUnchecked(
          new Error(CLOUDFLARE_401),
        ).issues;
        p.log.warn(
          `${ui.prose(issue!.message)}\n${ui.prose(issue!.resolution)}`,
        );
      },
    ],
    [
      "secrets' missing name",
      () => {
        p.log.error(
          describeMissingSecret(localSecrets(), NAME, {
            command: credentialPutCommand("android-keystore", NAME),
          }),
        );
      },
    ],
    [
      "keys' next step",
      () => {
        p.log.error(
          ui.withCommand("Export the key again, then rebuild:", COMMAND),
        );
      },
    ],
    [
      "deploy's signing refusal",
      () => {
        reportSigningRefusal(
          new Error(
            describeMissingSecret(localSecrets(), NAME, { command: COMMAND }),
          ),
        );
      },
    ],
    [
      "deploy's unexpected failure",
      () => reportUnexpectedError(new Error(CLOUDFLARE_401)),
    ],
    [
      "a block with a wide row",
      () => {
        p.log.step(
          ui.block("Infrastructure", [
            ui.kv("Note", "word ".repeat(40).trim()),
            ui.kv("Endpoint", `https://example.com/${"x".repeat(90)}`),
          ]),
        );
      },
    ],
    [
      "a table wider than a line",
      () => {
        p.log.message(
          ui.table(
            [
              { key: "id", label: "ID" },
              { key: "name", label: "Name" },
              { key: "created", label: "Created" },
            ],
            [
              {
                id: "0199c1d2-3e4f-7a5b-8c6d-9e0f1a2b3c4d",
                name: "Production app",
                created: "2026-10-30T04:50:17.000Z",
              },
            ],
          ),
        );
      },
    ],
  ])("fits %s", async (_name, print) => {
    const lines = await printedLines(print);
    expect(
      lines.filter(
        (line) => displayWidth(line) > 76 && /\s/u.test(line.slice(3).trim()),
      ),
    ).toEqual([]);
    expect(lines.join("\n")).not.toContain('"errors"');
  });

  it("shows a table that fits a line as a table", async () => {
    const lines = await printedLines(() => {
      p.log.message(
        ui.table([{ key: "a", label: "A" }], [{ a: "one" }, { a: "two" }]),
      );
    });
    expect(lines.join("\n")).toContain("│ one │");
  });

  it("keeps a table wider than a line bordered, with a row for each column", async () => {
    const lines = await printedLines(() => {
      p.log.message(
        ui.table(
          [
            { key: "id", label: "ID", format: ui.id },
            { key: "created", label: "Created" },
            { key: "note", label: "Note" },
          ],
          [
            { id: "a".repeat(40), created: "b".repeat(30), note: "" },
            {
              id: "c".repeat(90),
              created: "word ".repeat(30).trim(),
              note: "한글 ".repeat(40).trim(),
            },
          ],
        ),
      );
    });
    const text = lines.join("\n");
    expect(text).toContain(`│ ID      │ ${"a".repeat(40)}`);
    expect(text).toContain(`│ Created │ ${"b".repeat(30)}`);
    expect(text).toContain("├─");
    // A word wider than the cell stays whole on its own line.
    expect(lines).toContain(`│  ${"c".repeat(90)}`);
    // Every other line is the table's width: none wrapped.
    const rows = lines.filter((line) => /^│  [┌├└│]/u.test(line));
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map(displayWidth)).size).toBe(1);
    expect(displayWidth(rows[0]!)).toBeLessThanOrEqual(76);
  });

  it("says there are no rows when a wide table has none", async () => {
    const lines = await printedLines(() => {
      p.log.message(
        ui.table(
          [
            { key: "id", label: "x".repeat(40) },
            { key: "name", label: "y".repeat(40) },
          ],
          [],
        ),
      );
    });
    expect(lines.join("\n")).toContain("(none)");
  });
});

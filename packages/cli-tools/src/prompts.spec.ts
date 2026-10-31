import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { displayWidth } from "./messageLines";
import { p, toolOutput } from "./prompts";
import { registerSecretValue } from "./secretMasking";

const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";

const captureOutput = () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return {
    output,
    read: () => text,
  };
};

describe("what p prints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const LONG_PROSE =
    "Signing is disabled but HOT_UPDATER_PUBLIC_KEY exists in Info.plist, so this will cause OTA updates to be rejected on every device that has it.";
  const LONG_COMMAND =
    "npx hot-updater secrets put qa-missing-signing --kind bundle-signing-key <key.pem>";
  const LONG_URL = `https://example.com/${"x".repeat(90)}`;
  const WIDE = `🔑 ${"프로젝트 ".repeat(30).trim()}`;
  const COLORED = `\u001B[32m${"word ".repeat(30).trim()}\u001B[39m`;
  const MESSAGES = [LONG_PROSE, LONG_COMMAND, WIDE, COLORED];

  /** The lines wider than 76 columns that a space could have broken. */
  const tooWide = (text: string) =>
    text
      .split("\n")
      .filter(
        (line) => displayWidth(line) > 76 && /\s/u.test(line.slice(3).trim()),
      );

  it.each([
    "message",
    "info",
    "success",
    "step",
    "warn",
    "warning",
    "error",
  ] as const)("fits p.log.%s within 76 columns", (level) => {
    const { output, read } = captureOutput();
    for (const message of MESSAGES) p.log[level](message, { output });
    expect(read()).toContain("hot-updater secrets put");
    expect(tooWide(read())).toEqual([]);
  });

  it("fits a message of lines", () => {
    const { output, read } = captureOutput();
    p.log.message(MESSAGES, { output });
    expect(tooWide(read())).toEqual([]);
  });

  it("fits p.cancel, p.intro, p.outro, and p.note, whose box takes more", () => {
    const { output, read } = captureOutput();
    for (const message of MESSAGES) {
      p.cancel(message, { output });
      p.intro(message, { output });
      p.outro(message, { output });
      p.note(message, "Title", { output });
    }
    expect(tooWide(read())).toEqual([]);
  });

  it("fits a spinner's and a task's lines in CI", async () => {
    vi.stubEnv("CI", "true");
    const { output, read } = captureOutput();
    const spinner = p.spinner({ output });
    spinner.start(LONG_PROSE);
    spinner.stop(LONG_PROSE);
    await p.tasks([{ title: LONG_PROSE, task: () => LONG_COMMAND }], {
      output,
    });
    expect(read()).toContain("hot-updater secrets put");
    expect(tooWide(read())).toEqual([]);
  });

  it("keeps a URL whole on its own line", () => {
    const { output, read } = captureOutput();
    p.log.error(`Read ${LONG_URL} first.`, { output });
    expect(read()).toContain(`│  ${LONG_URL}\n`);
  });

  it("shows a provider's message for its JSON in an error or a warning", () => {
    const body =
      '401 {"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}';
    const { output, read } = captureOutput();
    p.log.error(`Failed: ${body}`, { output });
    p.log.warn(`Failed: ${body}`, { output });
    p.cancel(`Failed: ${body}`, { output });
    expect(read()).not.toContain('"errors"');
    expect(read().match(/Failed: 401 Authentication error/gu)).toHaveLength(3);
  });

  it("leaves JSON that isn't an error alone", () => {
    const { output, read } = captureOutput();
    p.log.info('{"message":"a stored value"}', { output });
    expect(read()).toContain('{"message":"a stored value"}');
  });

  it("masks a value before it fits a line, so no break splits it", () => {
    const value = "super secret value with spaces in it";
    registerSecretValue(value);
    const { output, read } = captureOutput();
    p.log.error(`${"word ".repeat(10)}${value}${" word".repeat(10)}`, {
      output,
    });
    expect(read()).not.toContain("super secret");
    expect(read()).not.toContain("spaces in it");
  });

  it("masks a value in a provider's JSON before cutting it", () => {
    const token = `sensitive-provider-token-${"x".repeat(60)}`;
    const escaped = 'sensitive "quoted" provider value';
    registerSecretValue(token);
    registerSecretValue(escaped);
    const { output, read } = captureOutput();
    p.log.error(JSON.stringify({ token }), { output });
    p.log.error(JSON.stringify({ message: `${"word ".repeat(28)}${token}` }), {
      output,
    });
    p.log.error(JSON.stringify({ message: `Refused ${escaped}` }), { output });
    expect(read()).not.toContain("sensitive");
    expect(read()).not.toContain("xxxx");
  });

  it("prints a tool's output as the tool wrote it", () => {
    const line = `error: ${"word ".repeat(30).trim()}`;
    const { output, read } = captureOutput();
    toolOutput.error(line, { output });
    expect(read()).toContain(line);
  });
});

describe("prompts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("renders tasks without terminal controls in CI", async () => {
    // Given
    vi.stubEnv("CI", "true");
    const captured = captureOutput();

    // When
    await p.tasks(
      [
        {
          title: "Uploading bundle",
          task: () => "Upload complete",
        },
      ],
      { output: captured.output },
    );

    // Then
    expect(captured.read()).toContain("Uploading bundle");
    expect(captured.read()).toContain("Upload complete");
    expect(captured.read()).not.toContain(CURSOR_HIDE);
    expect(captured.read()).not.toContain(CURSOR_SHOW);
  });

  it("renders the task error instead of a generic process-exit message", async () => {
    vi.stubEnv("CI", "true");
    const captured = captureOutput();

    await expect(
      p.tasks(
        [
          {
            title: "Check IAM policy",
            task: () => {
              throw new Error("The caller does not have permission");
            },
          },
        ],
        { output: captured.output },
      ),
    ).rejects.toThrow("The caller does not have permission");

    expect(captured.read()).toContain("The caller does not have permission");
    expect(captured.read()).not.toContain("Something went wrong");
  });

  it("omits transient progress messages when output is not a TTY", () => {
    // Given
    vi.useFakeTimers();
    const captured = captureOutput();
    const progress = p.progress({
      delay: 5,
      max: 100,
      output: captured.output,
    });

    // When
    progress.start("Uploading 0%");
    progress.advance(50, "Uploading 50%");
    vi.advanceTimersByTime(5);
    progress.stop("Upload complete");

    // Then
    expect(captured.read()).toContain("Uploading 0%");
    expect(captured.read()).toContain("Upload complete");
    expect(captured.read()).not.toContain("Uploading 50%");
    expect(captured.read()).not.toContain(CURSOR_HIDE);
    expect(captured.read()).not.toContain(CURSOR_SHOW);
  });

  it.each(["confirm", "select", "text", "password", "multiselect"] as const)(
    "refuses %s without a terminal instead of waiting on stdin",
    async (prompt) => {
      vi.stubEnv("CI", "");
      const input = new PassThrough();
      const captured = captureOutput();

      await expect(
        (p[prompt] as (options: object) => Promise<unknown>)({
          message: "Continue?",
          options: [{ value: "a" }],
          input,
          output: captured.output,
        }),
      ).rejects.toThrow(
        "Continue? The CLI asks nothing without a terminal: pass the command's options instead (see --help).",
      );
      expect(captured.read()).toBe("");
    },
  );

  it("refuses on a terminal in CI, where nobody answers", async () => {
    vi.stubEnv("CI", "true");
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
    });
    const captured = captureOutput();

    await expect(
      p.confirm({ message: "Continue?", input, output: captured.output }),
    ).rejects.toThrow(
      "Continue? The CLI asks nothing in CI (CI is set): pass the command's options instead (see --help).",
    );
    expect(captured.read()).toBe("");
  });

  it("asks on a terminal", async () => {
    vi.stubEnv("CI", "");
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
    });
    const captured = captureOutput();

    const answer = p.confirm({
      message: "Continue?",
      input,
      output: captured.output,
    });
    input.write("y");

    await expect(answer).resolves.toBe(true);
  });
});

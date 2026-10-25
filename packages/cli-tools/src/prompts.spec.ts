import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { p } from "./prompts";

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
        "Continue? There is no terminal to answer in: pass the command's options instead (see --help).",
      );
      expect(captured.read()).toBe("");
    },
  );

  it("asks on a terminal", async () => {
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

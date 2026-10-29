import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { p } from "./prompts";
import {
  createStep,
  formatDuration,
  startStep,
  truncateLine,
  withDuration,
  withStep,
} from "./step";

/** A stream that records what is written, as a terminal or as a CI log. */
const captureOutput = ({ tty = false, columns = 80 } = {}) => {
  let text = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += String(chunk);
        done();
      },
    }),
    { isTTY: tty, columns },
  );
  return {
    output,
    /** The lines written, without colors and cursor moves. */
    lines: () =>
      stripVTControlCharacters(text)
        .split("\n")
        .filter((line) => line.trim()),
    raw: () => text,
  };
};

describe("formatDuration", () => {
  it("reads as seconds, minutes, then hours", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(4_240)).toBe("4.2s");
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(59_600)).toBe("1m00s");
    expect(formatDuration(64_000)).toBe("1m04s");
    expect(formatDuration(401_000)).toBe("6m41s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});

describe("withDuration", () => {
  it("puts the duration at the right edge of a 73-column line", () => {
    const line = stripVTControlCharacters(
      withDuration("Archived CodexRelay", 401_000),
    );

    expect(line).toHaveLength(73);
    expect(line).toMatch(/^Archived CodexRelay {2,}6m41s$/);
  });

  it("cuts a message that would make the line wider", () => {
    const line = stripVTControlCharacters(withDuration("x".repeat(100), 1_000));

    expect(line).toHaveLength(73);
    expect(line).toMatch(/^x+… {2}1\.0s$/);
  });
});

describe("truncateLine", () => {
  it("keeps a line that fits, and cuts one that doesn't", () => {
    expect(truncateLine("Archiving App", 20)).toBe("Archiving App");
    expect(truncateLine("Archiving App · Compiling React-Core", 20)).toBe(
      "Archiving App · Com…",
    );
  });
});

describe("a step without a terminal, as in CI", () => {
  beforeEach(() => {
    vi.stubEnv("CI", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prints only its finished line, with its duration", async () => {
    const captured = captureOutput();

    const step = startStep("Archiving CodexRelay", {
      output: captured.output,
    });
    step.update("Compiling React-Core · 412 files");
    expect(captured.lines()).toEqual([]);
    step.succeed("Archived CodexRelay");

    expect(captured.lines()).toEqual([
      "│",
      expect.stringMatching(/^◇ {2}Archived CodexRelay {2,}\d+\.\ds$/),
    ]);
    // No spinner frames nor cursor moves.
    expect(captured.raw()).not.toContain("\u001B[?25l");
    expect(captured.raw()).not.toContain("Compiling");
  });

  it("shows inner spinners as its detail, and prints held logs after its line", async () => {
    const captured = captureOutput();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const step = startStep("Preparing iOS", { output: captured.output });
    const pods = p.spinner();
    pods.start("Installing CocoaPods dependencies");
    pods.stop("CocoaPods dependencies installed");
    p.log.info("Using bundler for CocoaPods installation");
    p.log.warn("No ios fingerprint in fingerprint.json yet");
    p.log.step("Updated fingerprint.json");
    expect(write).not.toHaveBeenCalled();
    step.succeed("Prepared iOS 1.7.0 · pods");

    const printed = stripVTControlCharacters(
      write.mock.calls.map(([chunk]) => String(chunk)).join(""),
    );
    write.mockRestore();
    expect(captured.lines()).toEqual([
      "│",
      expect.stringMatching(/^◇ {2}Prepared iOS 1\.7\.0 · pods {2,}\S+$/),
    ]);
    // The spinner and the info line were the step's detail; the warning
    // prints after its line.
    expect(printed).not.toContain("CocoaPods");
    expect(printed).not.toContain("bundler");
    expect(printed).toContain("No ios fingerprint in fingerprint.json yet");
    expect(printed).toContain("Updated fingerprint.json");
  });

  it("ends as failed before an error prints, since the process may exit", () => {
    const captured = captureOutput();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const step = startStep("Preparing iOS", { output: captured.output });
    p.log.error("Couldn't read the ios app version.");
    // The step already ended: a later fail prints nothing more.
    step.fail();

    write.mockRestore();
    expect(captured.lines()).toEqual([
      "│",
      expect.stringMatching(/^■ {2}Preparing iOS failed {2,}\S+$/),
    ]);
    expect(step.active).toBe(false);
  });

  it("names a step created inside another on the outer step's line", async () => {
    const captured = captureOutput();

    const outer = startStep("Submitting", { output: captured.output });
    await withStep("Uploading to TestFlight", async () => "done");
    outer.succeed("Submitted");

    expect(captured.lines()).toEqual([
      "│",
      expect.stringMatching(/^◇ {2}Submitted {2,}\S+$/),
    ]);
  });

  it("fails with its title when the run throws", async () => {
    const captured = captureOutput();

    await expect(
      withStep(
        "Uploading to Google Play",
        async () => {
          throw new Error("403");
        },
        () => "Uploaded",
        { output: captured.output },
      ),
    ).rejects.toThrow("403");
    expect(captured.lines()).toEqual([
      "│",
      expect.stringMatching(/^■ {2}Uploading to Google Play failed {2,}\S+$/),
    ]);
  });

  it("shows nothing before it starts", () => {
    const captured = captureOutput();

    const step = createStep("Preparing Android", { output: captured.output });
    step.succeed();

    expect(captured.lines()).toEqual([]);
    expect(step.elapsedMs).toBe(0);
  });
});

describe("a step at a terminal", () => {
  beforeEach(() => {
    vi.stubEnv("CI", "");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("updates one live line in place, cut to the terminal's width, then ends as its line", () => {
    const captured = captureOutput({ tty: true, columns: 40 });

    const step = startStep("Archiving CodexRelay", {
      output: captured.output,
    });
    step.update("Compiling React-Core · 412 files");
    vi.advanceTimersByTime(200);
    const live = captured.raw();
    step.succeed("Archived CodexRelay");

    // The spinner's frame, cut to fit 40 columns with its timer.
    expect(stripVTControlCharacters(live)).toContain(
      "◒  Archiving CodexRelay · Com… [0s]",
    );
    // Each frame, drawn over the last, fits the terminal.
    const frames = stripVTControlCharacters(live)
      .split(/(?=[◒◐◓◑])/u)
      .slice(1);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => [...frame].length <= 40)).toBe(true);
    // Erased in place, not printed line after line.
    expect(live).toContain("\u001B[");
    // The finished line is drawn where the live line was erased.
    expect(
      stripVTControlCharacters(captured.raw())
        .split(/(?=◇)/u)
        .at(-1),
    ).toMatch(/^◇ {2}Archived CodexRelay {2,}\d+\.\ds\n$/);
  });
});

import path from "path";
import { createInterface } from "readline";
import { PassThrough, type Readable } from "stream";

import { getCwd } from "./cwd";
import {
  createLogWriter,
  type HotUpdaterLogWriter,
  stripAnsi,
} from "./LogWriter";
import { p } from "./prompts";
import { type Step, startStep } from "./step";

type LinePattern = string | RegExp;

/** The tool's output a failed build prints: its errors, else its last lines. */
export interface BuildFailureSummaryConfig {
  /** Lines kept wherever they are, such as a compiler's `error:` lines. */
  lines: LinePattern[];
  /**
   * Blocks kept whole: from a line matching `start` through one matching
   * `end`, or up to it without `includeEnd`.
   */
  blocks: { start: LinePattern; end: LinePattern; includeEnd: boolean }[];
}

/**
 * Reads the short phase a live build line shows, such as `Compiling
 * React-Core · 412 files`, from each line of the tool's raw output, or
 * undefined for a line that starts no phase. One reader reads one run.
 */
export type BuildPhaseReader = (line: string) => string | undefined;

export interface BuildLoggerConfig {
  logPrefix: string;
  /**
   * The log file to append to, such as an archive's for its export, instead
   * of a new one.
   */
  logFilePath?: string;
  /** A phase reader for each run. */
  createPhaseReader: () => BuildPhaseReader;
  /** What a failure prints from the tool's raw output. */
  failureSummary: BuildFailureSummaryConfig;
}

/** The most lines a failure summary prints, and the tail it falls back to. */
const MAX_SUMMARY_LINES = 20;
const TAIL_LINES = 15;

const matchesSummaryPattern = (line: string, pattern: LinePattern) => {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(line);
  }
  return line.includes(pattern);
};

/**
 * A native build that failed, after its logger printed the summary of the
 * tool's output and the log file's path, so its message is one line.
 */
export class BuildFailedError extends Error {
  override name = "BuildFailedError";
  /** The build log, relative to the project, or null without one. */
  readonly logPath: string | null;
  /** The lines of the tool's output the summary printed. */
  readonly summary: string[];
  /**
   * What to do about it, such as accepting an agreement, which the summary
   * doesn't say: the one line a command prints after it, or null.
   */
  readonly hint: string | null;

  constructor(
    message: string,
    {
      logPath,
      summary,
      hint = null,
      cause,
    }: {
      logPath: string | null;
      summary: string[];
      hint?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause });
    this.logPath = logPath;
    this.summary = summary;
    this.hint = hint;
  }
}

/**
 * Runs a native build tool's output through a step: the step's live line
 * shows the phase its reader finds, the log file keeps the raw output, and a
 * failure prints the summary of it on stderr.
 */
export class BuildLogger {
  private logWriter?: HotUpdaterLogWriter;
  private step?: Step;
  private summaryLines: string[] = [];
  private tailLines: string[] = [];
  private openBlock?: BuildFailureSummaryConfig["blocks"][number];

  constructor(private readonly config: BuildLoggerConfig) {}

  /**
   * Opens the log, writes `header` to it, such as the tool's command line,
   * which the terminal doesn't show, and starts the step titled `title`.
   */
  async start({ title, header = [] }: { title: string; header?: string[] }) {
    this.summaryLines = [];
    this.tailLines = [];
    this.openBlock = undefined;
    this.logWriter = await createLogWriter({
      prefix: this.config.logPrefix,
      logFilePath: this.config.logFilePath,
    });
    if (header.length) this.logWriter.writeLines(header);
    this.step = startStep(title);
  }

  /**
   * Writes the tool's raw output to the log file, reads its failure summary
   * from it, and shows its phases on the step's line.
   */
  async processStream(input: Readable) {
    if (!this.logWriter) {
      throw new Error("BuildLogger has not been started. Call start() first.");
    }

    const progressInput = new PassThrough();
    const logInput = new PassThrough();
    const summaryInput = new PassThrough();
    input.pipe(progressInput);
    input.pipe(logInput);
    input.pipe(summaryInput);

    await Promise.all([
      this.consumeProgressStream(progressInput),
      this.logWriter.writeStream(logInput),
      this.consumeSummaryStream(summaryInput),
    ]);
  }

  /** The build log, relative to the project, or null without one. */
  get logPath(): string | null {
    return this.logWriter?.logFilePath
      ? path.relative(getCwd(), this.logWriter.logFilePath)
      : null;
  }

  /** The build log's absolute path, or null without one. */
  get logFilePath(): string | null {
    return this.logWriter?.logFilePath ?? null;
  }

  /**
   * The lines of the raw output a failure prints: the ones the config's
   * `failureSummary` keeps, deduplicated, or the last lines without any.
   */
  get failureSummary(): string[] {
    const lines = this.summaryLines.length
      ? this.summaryLines
      : this.tailLines.filter((line) => line.trim());
    // A block's blank lines are kept but at its ends.
    const first = lines.findIndex((line) => line.trim());
    const last = lines.findLastIndex((line) => line.trim());
    return first === -1 ? [] : lines.slice(first, last + 1);
  }

  private async consumeSummaryStream(input: Readable) {
    const lineReader = createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });

    for await (const rawLine of lineReader) {
      this.processSummaryLine(stripAnsi(rawLine).replace(/\r/g, "").trimEnd());
    }
  }

  private processSummaryLine(line: string) {
    this.tailLines.push(line);
    if (this.tailLines.length > TAIL_LINES) {
      this.tailLines.shift();
    }

    const { lines, blocks } = this.config.failureSummary;
    const trimmedLine = line.trim();
    if (this.openBlock) {
      if (matchesSummaryPattern(trimmedLine, this.openBlock.end)) {
        if (this.openBlock.includeEnd) this.keepSummaryLine(line);
        this.openBlock = undefined;
      } else {
        this.keepSummaryLine(line);
      }
      return;
    }

    const block = blocks.find(({ start }) =>
      matchesSummaryPattern(trimmedLine, start),
    );
    if (block) {
      this.openBlock = block;
      this.keepSummaryLine(line);
      return;
    }

    if (lines.some((pattern) => matchesSummaryPattern(trimmedLine, pattern))) {
      this.keepSummaryLine(line);
    }
  }

  private keepSummaryLine(line: string) {
    // xcodebuild and Gradle repeat an error; a long list is cut at the cap.
    if (
      this.summaryLines.length >= MAX_SUMMARY_LINES ||
      (line.trim() && this.summaryLines.includes(line))
    ) {
      return;
    }
    this.summaryLines.push(line);
  }

  private async consumeProgressStream(input: Readable) {
    const lineReader = createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });
    const readPhase = this.config.createPhaseReader();
    let phase: string | undefined;

    for await (const line of lineReader) {
      const next = readPhase(stripAnsi(line).replace(/\r/g, "").trim());
      if (next !== undefined && next !== phase) {
        phase = next;
        this.step?.update(phase);
      }
    }
  }

  /**
   * Ends the step with `message` and its duration, or, for a failure, as
   * failed, then prints the failure summary and the log's path.
   */
  stop(message?: string, success = true) {
    const step = this.step;
    if (!step?.active) {
      return;
    }

    if (success) {
      step.succeed(message);
    } else {
      step.fail(message);
      this.showFailureSummary();
    }
  }

  writeError(error: unknown) {
    this.logWriter?.writeError(error);
  }

  async close() {
    if (!this.logWriter) {
      return;
    }

    await this.logWriter.close();
    this.logWriter = undefined;
  }

  /**
   * Prints the failure summary and the log's path to stderr, so a `--json`
   * command's stdout stays its JSON.
   */
  private showFailureSummary() {
    const summary = this.failureSummary;
    const logPath = this.logPath;
    const message = [
      ...summary,
      ...(logPath
        ? [...(summary.length ? [""] : []), `Build log: ${logPath}`]
        : []),
    ].join("\n");
    if (message) {
      p.log.error(message, { output: process.stderr });
    }
  }
}

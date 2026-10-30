import path from "path";
import { createInterface } from "readline";
import { PassThrough, type Readable } from "stream";

import { getCwd } from "./cwd";
import {
  createLogWriter,
  type HotUpdaterLogWriter,
  stripAnsi,
} from "./LogWriter";
import { truncateLine } from "./messageLines";
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
  /**
   * Lines never printed, nor counted in the last lines, such as a
   * download's progress meter.
   */
  ignore?: LinePattern[];
  /**
   * How many of the last lines print after the kept ones, for a tool whose
   * error line is followed by its cause. Without it, the last lines print
   * only when no line is kept.
   */
  tail?: number;
  /** The widest a printed line is, cut with `…`: the log has it whole. */
  maxWidth?: number;
  /**
   * The line that ends the tool's report of its error, after which its
   * output is boilerplate, such as a crash report's links: the summary is
   * the kept lines, without the last lines.
   */
  stopAfter?: LinePattern;
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
/** A line of the tool's output, with its place in it. */
interface OutputLine {
  index: number;
  line: string;
}

export class BuildLogger {
  private logWriter?: HotUpdaterLogWriter;
  private step?: Step;
  private summaryLines: OutputLine[] = [];
  private tailLines: OutputLine[] = [];
  private lineCount = 0;
  private stopped = false;
  private openBlock?: BuildFailureSummaryConfig["blocks"][number];

  constructor(private readonly config: BuildLoggerConfig) {}

  /**
   * Opens the log, writes `header` to it, such as the tool's command line,
   * which the terminal doesn't show, and starts the step titled `title`.
   */
  async start({ title, header = [] }: { title: string; header?: string[] }) {
    this.summaryLines = [];
    this.tailLines = [];
    this.lineCount = 0;
    this.stopped = false;
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
   * `failureSummary` keeps, deduplicated, with its `tail` unless the output
   * reached `stopAfter`, or the last lines without any.
   */
  get failureSummary(): string[] {
    const { tail = 0, maxWidth } = this.config.failureSummary;
    const lastLines = this.tailLines.filter(({ line }) => line.trim());
    const kept = this.summaryLines;
    const keptText = new Set(kept.map(({ line }) => line));
    const lines = kept.length
      ? [
          ...kept,
          ...(tail && !this.stopped ? lastLines.slice(-tail) : []).filter(
            ({ line }) => !keptText.has(line),
          ),
        ]
          .sort((a, b) => a.index - b.index)
          .map(({ line }) => line)
      : lastLines.slice(-TAIL_LINES).map(({ line }) => line);
    // A block's blank lines are kept but at its ends.
    const first = lines.findIndex((line) => line.trim());
    const last = lines.findLastIndex((line) => line.trim());
    const summary = first === -1 ? [] : lines.slice(first, last + 1);
    return maxWidth
      ? summary.map((line) => truncateLine(line, maxWidth))
      : summary;
  }

  private async consumeSummaryStream(input: Readable) {
    const lineReader = createInterface({
      input,
      crlfDelay: Infinity,
      terminal: false,
    });

    for await (const rawLine of lineReader) {
      // A progress meter redraws its line after each \r: each is a line.
      const parts = stripAnsi(rawLine).split("\r");
      const lines =
        parts.length > 1 ? parts.filter((part) => part.trim()) : parts;
      for (const line of lines) this.processSummaryLine(line.trimEnd());
    }
  }

  private processSummaryLine(line: string) {
    const {
      lines,
      blocks,
      ignore = [],
      tail = 0,
      stopAfter,
    } = this.config.failureSummary;
    const trimmedLine = line.trim();
    if (
      this.stopped ||
      ignore.some((pattern) => matchesSummaryPattern(trimmedLine, pattern))
    ) {
      return;
    }
    if (stopAfter && matchesSummaryPattern(trimmedLine, stopAfter)) {
      this.stopped = true;
      this.openBlock = undefined;
    }

    const index = this.lineCount++;
    this.tailLines.push({ index, line });
    if (this.tailLines.length > Math.max(TAIL_LINES, tail)) {
      this.tailLines.shift();
    }

    if (this.openBlock) {
      if (matchesSummaryPattern(trimmedLine, this.openBlock.end)) {
        if (this.openBlock.includeEnd) this.keepSummaryLine(index, line);
        this.openBlock = undefined;
      } else {
        this.keepSummaryLine(index, line);
      }
      return;
    }

    const block = blocks.find(({ start }) =>
      matchesSummaryPattern(trimmedLine, start),
    );
    if (block) {
      this.openBlock = block;
      this.keepSummaryLine(index, line);
      return;
    }

    if (lines.some((pattern) => matchesSummaryPattern(trimmedLine, pattern))) {
      this.keepSummaryLine(index, line);
    }
  }

  private keepSummaryLine(index: number, line: string) {
    // xcodebuild and Gradle repeat an error; a long list is cut at the cap,
    // which leaves room for the tail.
    const { tail = 0 } = this.config.failureSummary;
    if (
      this.summaryLines.length >= MAX_SUMMARY_LINES - tail ||
      (line.trim() && this.summaryLines.some((kept) => kept.line === line))
    ) {
      return;
    }
    this.summaryLines.push({ index, line });
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

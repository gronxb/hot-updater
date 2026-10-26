import path from "path";
import { createInterface } from "readline";
import { PassThrough, type Readable } from "stream";

import { colors } from "./colors";
import { getCwd } from "./cwd";
import {
  createLogWriter,
  type HotUpdaterLogWriter,
  stripAnsi,
} from "./LogWriter";
import { type PromptProgress, p } from "./prompts";

type LinePattern = string | RegExp;

type BuildLoggerState = {
  completedStages: number;
  latestMessage: string;
  started: boolean;
  stopped: boolean;
};

const createInitialState = (): BuildLoggerState => ({
  completedStages: 0,
  latestMessage: "",
  started: false,
  stopped: false,
});

const normalizeLine = (line: string) => {
  const truncated = line.length > 50 ? `${line.slice(0, 50)}...` : line;
  return truncated.replace(/[\r\n]/g, " ").trim();
};

const matchesAnyPattern = ({
  line,
  patterns,
}: {
  line: string;
  patterns: LinePattern[];
}) => {
  const trimmedLine = line.trim();
  const normalizedLine = trimmedLine.toLowerCase();

  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(trimmedLine);
    }

    return normalizedLine.includes(pattern.toLowerCase());
  });
};

// Is it worth doing?
const getPatternMatchScore = ({
  line,
  patterns,
}: {
  line: string;
  patterns: LinePattern[];
}) => {
  const trimmedLine = line.trim();
  const normalizedLine = trimmedLine.toLowerCase();

  // Score reflects how specific a match is: longer patterns win ties over generic ones.
  return patterns.reduce((bestScore, pattern) => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      if (!pattern.test(trimmedLine)) {
        return bestScore;
      }

      return Math.max(bestScore, pattern.source.length);
    }

    const normalizedPattern = pattern.toLowerCase();
    if (!normalizedLine.includes(normalizedPattern)) {
      return bestScore;
    }

    return Math.max(bestScore, normalizedPattern.length);
  }, 0);
};

const resolveNextCompletedStage = ({
  line,
  progressStages,
  completedStages,
}: {
  line: string;
  progressStages: LinePattern[][];
  completedStages: number;
}) => {
  let nextCompletedStages = completedStages;
  let bestMatchScore = 0;

  // Search all remaining stages in one line and jump to the strongest/latest match.
  // This avoids missing progress when output emits multiple stage markers together.
  for (
    let stageIndex = completedStages;
    stageIndex < progressStages.length;
    stageIndex += 1
  ) {
    const matchScore = getPatternMatchScore({
      line,
      patterns: progressStages[stageIndex],
    });

    if (matchScore <= 0) {
      continue;
    }

    const candidateStage = stageIndex + 1;
    if (
      matchScore > bestMatchScore ||
      (matchScore === bestMatchScore && candidateStage > nextCompletedStages)
    ) {
      nextCompletedStages = candidateStage;
      bestMatchScore = matchScore;
    }
  }

  return nextCompletedStages;
};

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

export interface BuildLoggerConfig {
  logPrefix: string;
  /** Lines that should be surfaced in prompt output as important events. */
  importantLogPatterns: LinePattern[];
  /** Progress stages: stage index advances when corresponding output patterns are observed. */
  progressStages: LinePattern[][];
  /** What a failure prints from the tool's raw output. */
  failureSummary: BuildFailureSummaryConfig;
}

/** The most lines a failure summary prints, and the tail it falls back to. */
const MAX_SUMMARY_LINES = 60;
const TAIL_LINES = 40;

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

  constructor(
    message: string,
    {
      logPath,
      summary,
      cause,
    }: { logPath: string | null; summary: string[]; cause?: unknown },
  ) {
    super(message, { cause });
    this.logPath = logPath;
    this.summary = summary;
  }
}

export class BuildLogger {
  private state = createInitialState();
  private logWriter?: HotUpdaterLogWriter;
  private summaryLines: string[] = [];
  private tailLines: string[] = [];
  private openBlock?: BuildFailureSummaryConfig["blocks"][number];
  private readonly promptProgress: PromptProgress;
  private readonly stageCount: number;

  constructor(private readonly config: BuildLoggerConfig) {
    this.stageCount = config.progressStages.length;

    this.promptProgress = p.progress({
      indicator: "timer",
      max: config.progressStages.length,
      delay: 500,
    });
  }

  async start() {
    this.state = { ...createInitialState(), started: true };
    this.summaryLines = [];
    this.tailLines = [];
    this.openBlock = undefined;
    this.logWriter = await createLogWriter({
      prefix: this.config.logPrefix,
    });
    this.promptProgress.start();
  }

  /**
   * Writes the tool's raw output to the log file and reads its failure
   * summary from it, and shows progress from `display`, a formatter's
   * output of it such as xcbeautify's, or from the raw output without one.
   */
  async processStream(
    input: Readable,
    { display }: { display?: Readable } = {},
  ) {
    if (!this.logWriter) {
      throw new Error("BuildLogger has not been started. Call start() first.");
    }

    const progressInput = new PassThrough();
    const logInput = new PassThrough();
    const summaryInput = new PassThrough();
    // Fan out the raw stream to the log file writer and the summary, and
    // the displayed one to prompt progress parsing.
    (display ?? input).pipe(progressInput);
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

    for await (const line of lineReader) {
      this.processProgressLine(line);
    }
  }

  private processProgressLine(line: string) {
    const normalizedLine = normalizeLine(line);

    if (!normalizedLine) {
      return;
    }

    const nextCompletedStages = resolveNextCompletedStage({
      line: normalizedLine,
      progressStages: this.config.progressStages,
      completedStages: this.state.completedStages,
    });

    this.updateProgress({
      nextCompletedStages,
      latestMessage: normalizedLine,
    });
  }

  stop(message?: string, success = true) {
    if (!this.state.started || this.state.stopped) {
      return;
    }

    if (success) {
      this.finishRemainingProgress();
    }

    const finalMessage =
      message || (success ? "Build completed successfully" : "Build failed");

    if (success) {
      this.promptProgress.stop(finalMessage);
      this.showLogFileLocation();
    } else {
      this.promptProgress.error(finalMessage);
      this.showFailureSummary();
    }

    this.state = { ...this.state, stopped: true };
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

  private updateProgress({
    nextCompletedStages,
    latestMessage,
  }: {
    nextCompletedStages: number;
    latestMessage: string;
  }) {
    if (this.state.stopped) {
      return;
    }

    const progressDelta = nextCompletedStages - this.state.completedStages;

    if (progressDelta > 0) {
      this.promptProgress.advance(progressDelta, latestMessage);
    } else if (
      latestMessage &&
      latestMessage !== this.state.latestMessage &&
      this.shouldLogLine(latestMessage)
    ) {
      this.promptProgress.message(latestMessage);
    }

    this.state = {
      ...this.state,
      completedStages: Math.max(
        this.state.completedStages,
        nextCompletedStages,
      ),
      latestMessage,
    };
  }

  private finishRemainingProgress() {
    if (!this.promptProgress || this.state.completedStages >= this.stageCount) {
      return;
    }

    const remainingStages = this.stageCount - this.state.completedStages;
    this.promptProgress.advance(remainingStages, this.state.latestMessage);
    this.state = { ...this.state, completedStages: this.stageCount };
  }

  private shouldLogLine(line: string) {
    return matchesAnyPattern({
      line,
      patterns: this.config.importantLogPatterns,
    });
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

  private showLogFileLocation() {
    if (!this.logWriter?.logFilePath) {
      return;
    }

    const relativePath = path.relative(getCwd(), this.logWriter.logFilePath);
    const highlightedPath = colors.blueBright(relativePath);
    p.log.info(`Build log stored at ${highlightedPath}`);
  }
}

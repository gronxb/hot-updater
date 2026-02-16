import { PassThrough, type Readable } from "stream";
import { createLogWriter, type HotUpdaterLogWriter } from "./LogWriter";
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

const normalizeLine = ({ line }: { line: string }) => {
  return line.replace(/[\r\n]/g, "").trim();
};

const normalizeChunk = ({ chunk }: { chunk: unknown }) => {
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString();
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return String(chunk);
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

export interface BuildLoggerConfig {
  logPrefix: string;
  /** Lines that should be surfaced in prompt output as important events. */
  importantLogPatterns: LinePattern[];
  /** Progress stages: stage index advances when corresponding output patterns are observed. */
  progressStages: LinePattern[][];
}

export class BuildLogger {
  private state = createInitialState();
  private logWriter?: HotUpdaterLogWriter;
  private readonly progressInput = new PassThrough();
  private readonly promptProgress: PromptProgress;
  private bufferedPartialLine = "";
  private readonly stageCount: number;

  constructor(private readonly config: BuildLoggerConfig) {
    this.stageCount = config.progressStages.length;

    this.promptProgress = p.progress({
      indicator: "timer",
      max: config.progressStages.length,
      delay: 500,
      input: this.progressInput,
    });
  }

  async start() {
    this.state = { ...createInitialState(), started: true };
    this.logWriter = await createLogWriter({
      prefix: this.config.logPrefix,
    });
    this.promptProgress.start();
  }

  async processStream(input: Readable) {
    if (!this.logWriter) {
      throw new Error("BuildLogger has not been started. Call start() first.");
    }

    const progressInput = new PassThrough();
    const logInput = new PassThrough();
    // Fan out one process stream to both consumers: prompt progress parsing and log file writer.
    input.pipe(progressInput);
    input.pipe(logInput);

    await Promise.all([
      this.consumeProgressStream(progressInput),
      this.logWriter.writeStream(logInput),
    ]);
  }

  private async consumeProgressStream(input: Readable) {
    for await (const chunk of input) {
      const lineChunk = normalizeChunk({ chunk });

      if (!lineChunk) {
        continue;
      }

      this.progressInput.write(lineChunk);
      this.processProgressChunk(lineChunk);
    }

    this.flushProgressChunk();
  }

  private processProgressChunk(lineChunk: string) {
    const chunkWithPreviousRemainder = `${this.bufferedPartialLine}${lineChunk}`;
    const splitLines = chunkWithPreviousRemainder.split(/\r\n|\n|\r/g);
    this.bufferedPartialLine = splitLines.pop() ?? "";

    for (const line of splitLines) {
      this.processProgressLine(line);
    }
  }

  private flushProgressChunk() {
    if (!this.bufferedPartialLine) {
      return;
    }

    this.processProgressLine(this.bufferedPartialLine);
    this.bufferedPartialLine = "";
  }

  private processProgressLine(line: string) {
    const truncatedLine = line.slice(0, 100); // truncate after file logging
    const normalizedLine = normalizeLine({ line: truncatedLine });

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
    } else {
      this.promptProgress.error(finalMessage);
    }

    this.state = { ...this.state, stopped: true };
  }

  writeError(error: unknown) {
    this.logWriter?.writeError(error);
  }

  async close() {
    this.progressInput.end();

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
}

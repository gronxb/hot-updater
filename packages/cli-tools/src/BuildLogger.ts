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
    this.logWriter = await createLogWriter({
      prefix: this.config.logPrefix,
    });
    this.promptProgress.start();
  }

  processLine(line: string) {
    if (line) {
      this.logWriter?.writeLine(line);
    }
    line = line.slice(0, 100); // truncate after file logging
    const normalizedLine = normalizeLine({ line });

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

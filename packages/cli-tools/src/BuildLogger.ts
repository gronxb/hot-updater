import { createLogWriter, type HotUpdaterLogWriter } from "./LogWriter";
import { type PromptProgress, p } from "./prompts";

const MAX_PROGRESS = 100;

export interface BuildLoggerConfig {
  logPrefix: string;
  /** Patterns that indicate build failure (string or regex) */
  failurePatterns: Array<string | RegExp>;
  /** Progress mapping: [patterns, progress percentage] (string or regex) */
  progressMapping: Array<[Array<string | RegExp>, number]>;
}

export class BuildLogger {
  private currentProgress = 0;
  private latestInlineMessage = "";
  private renderedProgress = 0;
  private stopped = false;
  private started = false;
  private readonly promptProgress: PromptProgress;
  private logWriter?: HotUpdaterLogWriter;
  private config: BuildLoggerConfig;

  constructor(config: BuildLoggerConfig) {
    this.config = config;
    this.promptProgress = p.progress({ max: MAX_PROGRESS });
  }

  async start(projectName: string) {
    this.started = true;
    this.stopped = false;
    this.currentProgress = 0;
    this.renderedProgress = 0;
    this.latestInlineMessage = "";
    this.promptProgress.start(`Building ${projectName}`);
    this.logWriter = await createLogWriter({
      prefix: this.config.logPrefix ?? projectName,
    });
    this.updateProgressBar();
  }

  processLine(line: string) {
    const normalizedLine = this.normalizeLine(line);

    if (this.logWriter && line) {
      this.logWriter.writeLine(line);
    }

    if (this.stopped || !normalizedLine) {
      return;
    }

    if (this.matchesAnyPattern(normalizedLine, this.config.failurePatterns)) {
      this.stop("Build failed", false);
      return;
    }

    for (const [patterns, progress] of this.config.progressMapping) {
      if (this.matchesAnyPattern(normalizedLine, patterns)) {
        if (progress >= this.currentProgress) {
          this.currentProgress = progress;
        }
        break;
      }
    }

    this.latestInlineMessage = normalizedLine;

    this.updateProgressBar();
  }

  stop(message?: string, success = true) {
    if (!this.started || this.stopped) {
      return;
    }

    if (success && this.currentProgress < MAX_PROGRESS) {
      this.currentProgress = MAX_PROGRESS;
      this.updateProgressBar();
    }

    const finalMessage =
      message || (success ? "Build completed successfully" : "Build failed");
    this.promptProgress.stop(finalMessage);
    this.stopped = true;
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

  private updateProgressBar() {
    if (this.stopped) {
      this.promptProgress.stop();
      return;
    }

    if (this.currentProgress > this.renderedProgress) {
      const targetProgress = Math.min(this.currentProgress, MAX_PROGRESS);
      const delta = targetProgress - this.renderedProgress;
      this.promptProgress.advance(delta, this.latestInlineMessage);
      this.renderedProgress = targetProgress;
    }
  }

  private normalizeLine(line: string) {
    if (!this.started || this.stopped) {
      return "";
    }

    return line.replace(/[\r\n]/g, " ").trim();
  }

  private matchesAnyPattern(
    line: string,
    patterns: Array<string | RegExp>,
  ): boolean {
    const trimmed = line.trim();
    return patterns.some((pattern) => {
      if (pattern instanceof RegExp) {
        return pattern.test(trimmed);
      }
      return trimmed.toLowerCase().trim().includes(pattern.toLowerCase());
    });
  }
}

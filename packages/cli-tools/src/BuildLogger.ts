import { p } from "@hot-updater/cli-tools";

export interface BuildLoggerConfig {
  /** Patterns that indicate build failure (string or regex) */
  failurePatterns: Array<string | RegExp>;
  /** Patterns for important messages that should be logged (string or regex) */
  importantLogPatterns: Array<string | RegExp>;
  /** Progress mapping: [patterns, progress percentage] (string or regex) */
  progressMapping: Array<[Array<string | RegExp>, number]>;
}

export class BuildLogger {
  private currentProgress = 0;
  private spinner?: ReturnType<typeof p.spinner>;
  private config: BuildLoggerConfig;

  constructor(config: BuildLoggerConfig) {
    this.config = config;
  }

  start(projectName: string) {
    this.spinner = p.spinner();
    this.spinner.start(`Building ${projectName}`);
    this.updateSpinner();
  }

  processLine(line: string) {
    // Check for build failure
    if (this.matchesAnyPattern(line, this.config.failurePatterns)) {
      this.stop("Build failed", false);
      return;
    }

    // Update progress based on mapping
    for (const [patterns, progress] of this.config.progressMapping) {
      if (this.matchesAnyPattern(line, patterns)) {
        if (progress < this.currentProgress) {
          if (process.env.NODE_ENV === "development") {
            console.warn(
              `[BuildLogger] Progress regression detected: ${progress}% < current ${this.currentProgress}% for patterns: ${patterns.join(", ")}`,
            );
          }
          // Don't update if progress would go backwards
          break;
        }
        this.currentProgress = progress;
        this.updateSpinner();
        break;
      }
    }

    // Log important messages
    if (this.shouldLogLine(line)) {
      p.log.info(line.trim());
    }
  }

  stop(message?: string, success = true) {
    if (this.spinner) {
      if (success) {
        this.spinner.stop(message || "Build completed successfully");
      } else {
        this.spinner.stop(message || "Build failed");
      }
    }
  }

  private updateSpinner() {
    if (!this.spinner) return;

    const progressBar = this.generateProgressBar(this.currentProgress);
    this.spinner.message(`${progressBar} ${this.currentProgress}%`);
  }

  private generateProgressBar(progress: number) {
    const width = 20;
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  }

  private shouldLogLine(line: string) {
    return this.matchesAnyPattern(line, this.config.importantLogPatterns);
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

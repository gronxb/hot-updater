import * as p from "@clack/prompts";

/**
 * Build phase information for progress tracking
 */
interface BuildPhase {
  /** Phase name */
  name: string;
  /** Progress percentage when this phase completes */
  progress: number;
  /** Whether this phase has been completed */
  completed: boolean;
}

/**
 * Build progress monitor for xcodebuild output
 */
export class XcodebuildLogger {
  private currentProgress = 0;
  private spinner?: ReturnType<typeof p.spinner>;
  private buildSucceeded = false;

  /**
   * Starts monitoring the build process
   * @param projectName - Name of the project being built
   */
  start(projectName: string): void {
    this.spinner = p.spinner();
    this.spinner.start(`Building ${projectName}`);
    this.updateSpinner();
  }

  /**
   * Processes a line of xcodebuild output
   * @param line - Line from xcodebuild stdout/stderr
   */
  processLine(line: string): void {
    // Check for build success
    if (
      line.includes("BUILD SUCCEEDED") ||
      line.includes("ARCHIVE SUCCEEDED")
    ) {
      this.buildSucceeded = true;
      this.currentProgress = 100;
      this.updateSpinner();
      return;
    }

    // Check for build failure
    if (line.includes("BUILD FAILED") || line.includes("ARCHIVE FAILED")) {
      this.stop("Build failed", false);
      return;
    }

    // Check for specific React Native and CocoaPods phases
    if (line.includes("PhaseScriptExecution")) {
      if (line.includes("[CP-User]\\ [Hermes]\\ Replace\\ Hermes\\")) {
        this.currentProgress = Math.max(this.currentProgress, 10);
        this.updateSpinner();
      } else if (
        line.includes("[CP-User]\\ [RN]Check\\ rncore") &&
        line.includes("React-Fabric")
      ) {
        this.currentProgress = Math.max(this.currentProgress, 35);
        this.updateSpinner();
      } else if (line.includes("[CP-User]\\ [RN]Check\\ FBReactNativeSpec")) {
        this.currentProgress = Math.max(this.currentProgress, 53);
        this.updateSpinner();
      } else if (
        line.includes("[CP-User]\\ [RN]Check\\ rncore") &&
        line.includes("React-FabricComponents")
      ) {
        this.currentProgress = Math.max(this.currentProgress, 66);
        this.updateSpinner();
      } else if (line.includes("[CP]\\ Check\\ Pods\\ Manifest.lock")) {
        this.currentProgress = Math.max(this.currentProgress, 90);
        this.updateSpinner();
      }
    }

    // Log important messages
    if (this.shouldLogLine(line)) {
      p.log.info(line.trim());
    }
  }

  /**
   * Stops the build monitor
   * @param message - Final message to display
   * @param success - Whether the build was successful
   */
  stop(message?: string, success = true): void {
    if (this.spinner) {
      if (success || this.buildSucceeded) {
        this.spinner.stop(message || "Build completed successfully");
      } else {
        this.spinner.stop(message || "Build failed");
      }
    }
  }

  /**
   * Updates spinner message with current progress
   */
  private updateSpinner(): void {
    if (!this.spinner) return;

    const progressBar = this.generateProgressBar(this.currentProgress);
    this.spinner.message(`${progressBar} ${this.currentProgress}%`);
  }

  /**
   * Generates a visual progress bar
   * @param progress - Progress percentage (0-100)
   * @returns ASCII progress bar
   */
  private generateProgressBar(progress: number): string {
    const width = 20;
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  }

  /**
   * Determines if a line should be logged to the user
   * @param line - Line from xcodebuild output
   * @returns True if line should be logged
   */
  private shouldLogLine(line: string): boolean {
    const importantPrefixes = [
      "error:",
      // "warning:",
      // "note:",
      // "ld:",
      // "clang:",
      "** BUILD FAILED **",
      "** ARCHIVE FAILED **",
      "The following build commands failed:",
    ];

    const lowerLine = line.toLowerCase();
    return importantPrefixes.some((prefix) =>
      lowerLine.includes(prefix.toLowerCase()),
    );
  }

  /**
   * Gets current build progress
   * @returns Progress percentage (0-100)
   */
  getProgress(): number {
    return this.currentProgress;
  }

  /**
   * Checks if build has succeeded
   * @returns True if build succeeded
   */
  isSuccessful(): boolean {
    return this.buildSucceeded;
  }

  /**
   * Resets the monitor for a new build
   */
  reset(): void {
    this.currentProgress = 0;
    this.buildSucceeded = false;
  }
}

import * as p from "@clack/prompts";

export class XcodebuildLogger {
  private currentProgress = 0;
  private spinner?: ReturnType<typeof p.spinner>;
  private buildSucceeded = false;

  start(projectName: string) {
    this.spinner = p.spinner();
    this.spinner.start(`Building ${projectName}`);
    this.updateSpinner();
  }

  processLine(line: string) {
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

  stop(message?: string, success = true) {
    if (this.spinner) {
      if (success || this.buildSucceeded) {
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

  getProgress() {
    return this.currentProgress;
  }

  isSuccessful() {
    return this.buildSucceeded;
  }

  reset() {
    this.currentProgress = 0;
    this.buildSucceeded = false;
  }
}

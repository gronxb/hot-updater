import * as p from "@clack/prompts";
import { execa } from "execa";

/**
 * Options for macOS app operations
 */
export interface MacRunnerOptions {
  /** Source directory for operation context */
  sourceDir?: string;
  /** Whether to run in detached mode */
  detached?: boolean;
}

/**
 * Mac runner for macOS applications
 */
export class MacRunner {
  /**
   * Launches a macOS app using the open command
   * @param appPath - Path to the .app bundle
   * @param options - Launch options
   *
   * @example
   * ```typescript
   * const runner = new MacRunner();
   * await runner.launch("/path/to/MyApp.app");
   * ```
   */
  async launch(appPath: string, options: MacRunnerOptions = {}): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Launching macOS app");

    try {
      await execa("open", [appPath], {
        cwd: options.sourceDir,
      });
      spinner.stop("Successfully launched macOS app");
    } catch (error) {
      spinner.stop("Failed to launch macOS app");
      throw new Error(`Failed to launch the macOS app: ${error}`);
    }
  }

  /**
   * Launches a Mac Catalyst app directly
   * @param appPath - Path to the .app bundle
   * @param scheme - Scheme name for the executable
   * @param options - Launch options
   *
   * @example
   * ```typescript
   * const runner = new MacRunner();
   * await runner.launchCatalyst("/path/to/MyApp.app", "MyApp");
   * ```
   */
  async launchCatalyst(
    appPath: string,
    scheme: string,
    options: MacRunnerOptions = {},
  ): Promise<void> {
    const executablePath = `${appPath}/${scheme}`;

    const spinner = p.spinner();
    spinner.start("Launching Mac Catalyst app");

    try {
      const process = execa(executablePath, [], {
        detached: options.detached ?? true,
        stdio: "ignore",
        cwd: options.sourceDir,
      });

      // Unref the process so it doesn't keep the parent alive
      if (options.detached !== false) {
        process.unref();
      }

      spinner.stop("Successfully launched Mac Catalyst app");
    } catch (error) {
      spinner.stop("Failed to launch Mac Catalyst app");
      throw new Error(`Failed to launch the Mac Catalyst app: ${error}`);
    }
  }

  /**
   * Opens a macOS app with specific arguments
   * @param appPath - Path to the .app bundle
   * @param args - Arguments to pass to the app
   * @param options - Launch options
   *
   * @example
   * ```typescript
   * const runner = new MacRunner();
   * await runner.openWithArgs("/path/to/MyApp.app", ["--debug", "--verbose"]);
   * ```
   */
  async openWithArgs(
    appPath: string,
    args: string[] = [],
    options: MacRunnerOptions = {},
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start("Opening macOS app with arguments");

    try {
      await execa("open", [appPath, "--args", ...args], {
        cwd: options.sourceDir,
      });
      spinner.stop("Successfully opened macOS app with arguments");
    } catch (error) {
      spinner.stop("Failed to open macOS app with arguments");
      throw new Error(`Failed to open the macOS app with arguments: ${error}`);
    }
  }

  /**
   * Terminates a running macOS app by bundle ID
   * @param bundleId - App bundle identifier
   * @param options - Termination options
   *
   * @example
   * ```typescript
   * const runner = new MacRunner();
   * await runner.terminate("com.example.myapp");
   * ```
   */
  async terminate(
    bundleId: string,
    options: MacRunnerOptions = {},
  ): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Terminating app ${bundleId}`);

    try {
      await execa(
        "osascript",
        ["-e", `tell application id "${bundleId}" to quit`],
        {
          cwd: options.sourceDir,
        },
      );
      spinner.stop(`Successfully terminated app ${bundleId}`);
    } catch (error) {
      spinner.stop(`Failed to terminate app ${bundleId}`);
      // Don't throw here as the app might not be running
      p.log.warn(`Could not terminate app ${bundleId}: ${error}`);
    }
  }

  /**
   * Gets information about a running macOS app
   * @param bundleId - App bundle identifier
   * @returns App information or null if not running
   *
   * @example
   * ```typescript
   * const runner = new MacRunner();
   * const info = await runner.getAppInfo("com.example.myapp");
   * ```
   */
  async getAppInfo(
    bundleId: string,
  ): Promise<{ isRunning: boolean; pid?: number } | null> {
    try {
      const { stdout } = await execa("pgrep", ["-f", bundleId]);
      const pids = stdout.split("\\n").filter(Boolean).map(Number);

      return {
        isRunning: pids.length > 0,
        pid: pids[0],
      };
    } catch (error) {
      // pgrep returns non-zero exit code if no process found
      return { isRunning: false };
    }
  }
}

/**
 * Creates a new MacRunner instance
 * @returns New MacRunner instance
 */
export const createMacRunner = (): MacRunner => {
  return new MacRunner();
};

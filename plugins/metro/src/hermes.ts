import fs from "fs";
import path from "path";
import { execa } from "execa";

/**
 * Returns the Hermes OS binary folder name for the current platform.
 */
function getHermesOSBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    default:
      return "linux64-bin";
  }
}

/**
 * Returns the Hermes executable name for the current platform.
 */
function getHermesOSExe(): string {
  const hermesExecutableName = "hermesc";
  return process.platform === "win32"
    ? `${hermesExecutableName}.exe`
    : hermesExecutableName;
}

/**
 * Returns the path to the react-native package.
 * Uses require.resolve to locate the path directly.
 */
function getReactNativePackagePath(): string {
  try {
    return path.dirname(require.resolve("react-native/package.json"));
  } catch (error) {
    return path.join("node_modules", "react-native");
  }
}

/**
 * Returns the path to the react-native compose-source-maps.js script.
 */
function getComposeSourceMapsPath(): string | null {
  const rnPackagePath = getReactNativePackagePath();
  const composeSourceMaps = path.join(
    rnPackagePath,
    "scripts",
    "compose-source-maps.js",
  );
  return fs.existsSync(composeSourceMaps) ? composeSourceMaps : null;
}

/**
 * Finds the Hermes command.
 * If Hermes is bundled with react-native, returns the hermesc path.
 * Otherwise, returns the path from node_modules/hermes-engine or hermesvm.
 *
 * @returns Full path to the Hermes executable
 */
export async function getHermesCommand(): Promise<string> {
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };

  // Since react-native 0.69, Hermes is bundled with it.
  const bundledHermesEngine = path.join(
    getReactNativePackagePath(),
    "sdks",
    "hermesc",
    getHermesOSBin(),
    getHermesOSExe(),
  );
  if (fileExists(bundledHermesEngine)) {
    return bundledHermesEngine;
  }

  // Prefer hermes-engine if it exists.
  const hermesEngine = path.join(
    "node_modules",
    "hermes-engine",
    getHermesOSBin(),
    getHermesOSExe(),
  );
  if (fileExists(hermesEngine)) {
    return hermesEngine;
  }

  // Otherwise, fallback to hermesvm.
  return path.join("node_modules", "hermesvm", getHermesOSBin(), "hermes");
}

/**
 * Compiles a JS bundle into an HBC file using the Hermes compiler,
 * and merges the source maps if enabled.
 *
 * @param inputJsFile - Path to the input JS file
 * @param outputHbcFile - Output HBC file path
 * @param sourcemapOutput - (Optional) Final sourcemap file path
 * @returns The full path to the compiled HBC file
 */
export async function compileHermes({
  outputHbcFile,
  sourcemapOutput,
  inputJsFile,
}: {
  outputHbcFile: string;
  sourcemapOutput?: string;
  inputJsFile: string;
}): Promise<string> {
  const hermesArgs = ["-emit-binary", "-out", outputHbcFile, inputJsFile];

  if (sourcemapOutput) {
    hermesArgs.push("-output-source-map");
  }

  const hermesCommand = await getHermesCommand();

  try {
    await execa(hermesCommand, hermesArgs);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to compile with Hermes: ${error.message}`);
    }
    throw new Error(`Failed to compile with Hermes: ${error}`);
  }

  if (sourcemapOutput) {
    const hermesSourceMapFile = `${outputHbcFile}.map`;
    if (!fs.existsSync(hermesSourceMapFile)) {
      throw new Error(
        `Hermes-generated sourcemap file (${hermesSourceMapFile}) not found.`,
      );
    }

    const composeSourceMapsPath = getComposeSourceMapsPath();
    if (!composeSourceMapsPath) {
      throw new Error(
        "Could not find react-native's compose-source-maps.js script.",
      );
    }

    try {
      await execa("node", [
        composeSourceMapsPath,
        sourcemapOutput,
        hermesSourceMapFile,
        "-o",
        sourcemapOutput,
      ]);
      fs.unlinkSync(hermesSourceMapFile);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to run compose-source-maps script: ${error.message}`,
        );
      }
      throw new Error(`Failed to run compose-source-maps script: ${error}`);
    }
  }

  return outputHbcFile;
}

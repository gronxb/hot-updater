import fs from "fs";
import path from "path";

import { execa } from "execa";

import { extractAppBundle } from "./utils/extractBuiltInBundle";

export interface Simulator {
  readonly udid: string;
  readonly name: string;
  /** `Booted`, `Shutdown`, and the states between them, as `simctl` says. */
  readonly state: string;
}

const simctl = async (args: readonly string[]): Promise<string> => {
  try {
    return (await execa("xcrun", ["simctl", ...args])).stdout;
  } catch (error) {
    const { code, stderr, shortMessage } = error as {
      readonly code?: string;
      readonly stderr?: string;
      readonly shortMessage?: string;
    };
    if (code === "ENOENT") {
      throw new Error(
        "The iOS Simulator needs Xcode on a Mac.\nInstall Xcode, then run this again.",
      );
    }
    throw new Error(stderr?.trim() || shortMessage || String(error));
  }
};

/** Every simulator on this Mac, booted or not. */
export const listSimulators = async (): Promise<readonly Simulator[]> => {
  const { devices } = JSON.parse(
    await simctl(["list", "devices", "--json"]),
  ) as { readonly devices: Readonly<Record<string, readonly Simulator[]>> };
  return Object.values(devices)
    .flat()
    .map(({ udid, name, state }) => ({ udid, name, state }));
};

/**
 * The simulator to install on: `udid`, or else the only booted one, by its
 * UDID. `simctl`'s own `booted` alias picks one of several by itself.
 */
export const selectSimulator = (
  simulators: readonly Simulator[],
  udid?: string,
): Simulator => {
  if (udid !== undefined) {
    const simulator = simulators.find((candidate) => candidate.udid === udid);
    if (simulator === undefined) {
      throw new Error(
        `No iOS Simulator has the UDID ${udid}.\nList them: xcrun simctl list devices`,
      );
    }
    if (simulator.state !== "Booted") {
      throw new Error(
        `${simulator.name} isn't booted.\nBoot it: xcrun simctl boot ${udid}`,
      );
    }
    return simulator;
  }
  const booted = simulators.filter(({ state }) => state === "Booted");
  const [only] = booted;
  if (only === undefined) {
    throw new Error("No iOS Simulator is booted.\nBoot one: open -a Simulator");
  }
  if (booted.length > 1) {
    throw new Error(
      [
        `${booted.length} iOS Simulators are booted:`,
        ...booted.map(({ udid, name }) => `  ${udid}  ${name}`),
        "Pick one with --simulator <udid>.",
      ].join("\n"),
    );
  }
  return only;
};

/**
 * Unpacks a simulator build's `.app.zip` into `outputPath`, and returns the
 * `.app` in it.
 */
export const extractSimulatorApp = async ({
  archivePath,
  outputPath,
}: {
  readonly archivePath: string;
  readonly outputPath: string;
}): Promise<string> => {
  await extractAppBundle({ archivePath, outputPath });
  const entries = await fs.promises.readdir(outputPath);
  const app = entries.find((entry) => entry.endsWith(".app"));
  if (app === undefined) {
    throw new Error(`${path.basename(archivePath)} holds no .app.`);
  }
  return path.join(outputPath, app);
};

/** Installs a `.app` on a booted simulator, and opens it. */
export const installOnSimulator = async ({
  udid,
  appPath,
  appId,
}: {
  readonly udid: string;
  readonly appPath: string;
  /** The app's `CFBundleIdentifier`. */
  readonly appId: string;
}): Promise<void> => {
  await simctl(["install", udid, appPath]);
  await simctl(["launch", udid, appId]);
};

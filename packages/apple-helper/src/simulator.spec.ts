import fs from "fs";
import os from "os";
import path from "path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractSimulatorApp,
  installOnSimulator,
  listSimulators,
  selectSimulator,
} from "./simulator";

vi.mock("execa", () => ({ execa: vi.fn() }));

const run = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

const simulator = (udid: string, state: string, name = `iPhone ${udid}`) => ({
  udid,
  name,
  state,
});

describe("listSimulators", () => {
  beforeEach(() => {
    run.mockReset();
  });

  it("reads every runtime's simulators", async () => {
    run.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          "iOS-26-4": [
            { udid: "A", name: "iPhone A", state: "Booted", isAvailable: true },
          ],
          "iOS-27-0": [{ udid: "B", name: "iPhone B", state: "Shutdown" }],
        },
      }),
    });

    await expect(listSimulators()).resolves.toEqual([
      simulator("A", "Booted"),
      simulator("B", "Shutdown"),
    ]);
    expect(run).toHaveBeenCalledWith("xcrun", [
      "simctl",
      "list",
      "devices",
      "--json",
    ]);
  });

  it("says Xcode is what's missing when there is no xcrun", async () => {
    run.mockRejectedValue(
      Object.assign(new Error("spawn"), { code: "ENOENT" }),
    );

    await expect(listSimulators()).rejects.toThrow(
      "The iOS Simulator needs Xcode on a Mac.\nInstall Xcode, then run this again.",
    );
  });
});

describe("selectSimulator", () => {
  it("takes the only booted one, by its UDID", () => {
    expect(
      selectSimulator([simulator("A", "Shutdown"), simulator("B", "Booted")]),
    ).toEqual(simulator("B", "Booted"));
  });

  it("takes the one named, of several booted", () => {
    expect(
      selectSimulator([simulator("A", "Booted"), simulator("B", "Booted")], "B")
        .udid,
    ).toBe("B");
  });

  it("gives one next step when none is booted", () => {
    expect(() => selectSimulator([simulator("A", "Shutdown")])).toThrow(
      "No iOS Simulator is booted.\nBoot one: open -a Simulator",
    );
  });

  it("names the choices when several are booted, rather than picking", () => {
    expect(() =>
      selectSimulator([simulator("A", "Booted"), simulator("B", "Booted")]),
    ).toThrow(
      "2 iOS Simulators are booted:\n  A  iPhone A\n  B  iPhone B\nPick one with --simulator <udid>.",
    );
  });

  it("refuses a UDID it doesn't know, or that isn't booted", () => {
    expect(() => selectSimulator([simulator("A", "Booted")], "Z")).toThrow(
      "No iOS Simulator has the UDID Z.\nList them: xcrun simctl list devices",
    );
    expect(() => selectSimulator([simulator("A", "Shutdown")], "A")).toThrow(
      "iPhone A isn't booted.\nBoot it: xcrun simctl boot A",
    );
  });
});

describe("extractSimulatorApp", () => {
  let directory: string;

  beforeEach(async () => {
    run.mockReset();
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "simulator-"));
  });

  afterEach(() => fs.promises.rm(directory, { force: true, recursive: true }));

  it("returns the .app the archive unpacked to", async () => {
    run.mockImplementation(async (_file: string, args: string[]) => {
      await fs.promises.mkdir(path.join(args.at(-1)!, "App.app"));
      return { stdout: "" };
    });

    await expect(
      extractSimulatorApp({
        archivePath: "/tmp/App.app.zip",
        outputPath: directory,
      }),
    ).resolves.toBe(path.join(directory, "App.app"));
  });

  it("says so when the archive holds no .app", async () => {
    run.mockResolvedValue({ stdout: "" });

    await expect(
      extractSimulatorApp({
        archivePath: "/tmp/App.app.zip",
        outputPath: directory,
      }),
    ).rejects.toThrow("App.app.zip holds no .app.");
  });
});

describe("installOnSimulator", () => {
  beforeEach(() => {
    run.mockReset();
  });

  it("installs on that simulator, then opens the app", async () => {
    run.mockResolvedValue({ stdout: "" });

    await installOnSimulator({
      udid: "A",
      appPath: "/tmp/App.app",
      appId: "com.example.app",
    });

    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ["simctl", "install", "A", "/tmp/App.app"],
      ["simctl", "launch", "A", "com.example.app"],
    ]);
  });

  it("doesn't open an app that didn't install, and says why", async () => {
    run.mockRejectedValue(
      Object.assign(new Error("failed"), { stderr: "Invalid device: A\n" }),
    );

    await expect(
      installOnSimulator({
        udid: "A",
        appPath: "/tmp/App.app",
        appId: "com.example.app",
      }),
    ).rejects.toThrow("Invalid device: A");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

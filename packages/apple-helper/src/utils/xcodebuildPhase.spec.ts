import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createXcodebuildPhaseReader } from "./xcodebuildPhase";

/** Lines of a real `xcodebuild archive` of an Expo app, paths anonymized. */
const ARCHIVE = fs
  .readFileSync(
    path.join(__dirname, "__fixtures__", "xcodebuild-archive.log"),
    "utf8",
  )
  .split("\n");

const phases = (lines: readonly string[]) => {
  const read = createXcodebuildPhaseReader();
  return lines.flatMap((line) => read(line) ?? []);
};

describe("createXcodebuildPhaseReader", () => {
  it("reads each action of an archive as a short phase, with its target", () => {
    expect(phases(ARCHIVE)).toEqual([
      "Resolving packages",
      "Planning the build",
      "Running [CP-User] [Hermes] Replace Hermes for the right configuration, if needed",
      "Running [CP-User] [RNDeps] Replace React Native Dependencies for the right configuration, if needed",
      "Processing SDWebImage-SDWebImage",
      "Compiling assets expo-dev-menu-EXDevMenu",
      "Running [CP] Copy XCFrameworks",
      "Compiling MMKVCore · 1 file",
      "Compiling MMKVCore · 2 files",
      "Compiling MMKVCore · 3 files",
      "Precompiling modules · 1",
      "Compiling expo-dev-menu-interface · 8 files",
      "Compiling expo-dev-menu-interface · 9 files",
      "Precompiling modules · 2",
      "Precompiling modules · 3",
      "Linking expo-dev-menu-interface",
      "Linking CodexRelay",
      "Bundling JavaScript",
      "Generating dSYM CodexRelay",
      "Copying CodexRelay",
      "Signing CodexRelay",
      "Validating CodexRelay",
    ]);
  });

  it("counts every file of a batched Swift compile", () => {
    const read = createXcodebuildPhaseReader();

    expect(
      read(
        "SwiftCompile normal arm64 Compiling\\ A.swift,\\ B.swift,\\ C.swift /src/A.swift /src/B.swift /src/C.swift (in target 'App' from project 'App')",
      ),
    ).toBe("Compiling App · 3 files");
    expect(
      read(
        "CompileC /dd/B.o /src/B.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'React-Core' from project 'Pods')",
      ),
    ).toBe("Compiling React-Core · 4 files");
  });

  it("reads nothing from a line that starts no phase", () => {
    const read = createXcodebuildPhaseReader();

    expect(read("")).toBeUndefined();
    expect(read("    cd /src/ios")).toBeUndefined();
    expect(
      read("note: Using codesigning identity override: -"),
    ).toBeUndefined();
    expect(read("** ARCHIVE SUCCEEDED **")).toBeUndefined();
    expect(
      read("/src/App.swift:12:5: error: cannot find 'x' in scope"),
    ).toBeUndefined();
  });
});

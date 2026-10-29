import type { BuildPhaseReader } from "@hot-updater/cli-tools";

/** The `(in target 'X' from project 'Y')` that ends an action's line. */
const TARGET = /\(in target '([^']+)' from project '[^']+'\)\s*$/;

/** A `PhaseScriptExecution` line's script phase, its spaces escaped. */
const SCRIPT = /^PhaseScriptExecution ((?:\\.|[^\s\\])+)/;

/** A batched `SwiftCompile`'s files: `Compiling\ A.swift,\ B.swift`. */
const SWIFT_BATCH = /^SwiftCompile \S+ \S+ Compiling\\ ((?:\\.|[^\s\\])+)/;

const unescape = (value: string) => value.replace(/\\(.)/g, "$1");

/** Actions whose lines say what xcodebuild is doing, by their first word. */
const ACTIONS: Record<string, string> = {
  CompileAssetCatalog: "Compiling assets",
  CompileAssetCatalogVariant: "Compiling assets",
  LinkAssetCatalog: "Compiling assets",
  CompileStoryboard: "Compiling storyboards",
  CompileXIB: "Compiling storyboards",
  LinkStoryboards: "Compiling storyboards",
  Ld: "Linking",
  Libtool: "Linking",
  CodeSign: "Signing",
  ProcessInfoPlistFile: "Processing",
  ProcessProductPackaging: "Processing",
  ProcessProductPackagingDER: "Processing",
  CopySwiftLibs: "Copying",
  CpResource: "Copying",
  GenerateDSYMFile: "Generating dSYM",
  Strip: "Stripping",
  Validate: "Validating",
};

const COMPILES = new Set(["CompileC", "SwiftCompile", "CompileSwift"]);

const PRECOMPILES = new Set([
  "PrecompileModule",
  "ScanDependencies",
  "SwiftExplicitDependencyGeneratePcm",
  "SwiftExplicitDependencyCompileModuleFromInterface",
]);

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Reads the phase of an `xcodebuild` build, archive, or export from its raw
 * output: `Compiling React-Core · 412 files`, `Linking CodexRelay`,
 * `Signing CodexRelay`, `Bundling JavaScript`, with the target each
 * action's line names.
 */
export const createXcodebuildPhaseReader = (): BuildPhaseReader => {
  let compiled = 0;
  let precompiled = 0;
  return (line) => {
    const space = line.indexOf(" ");
    const action = space === -1 ? line : line.slice(0, space);
    const target = TARGET.exec(line)?.[1];
    const withTarget = (phase: string) =>
      target ? `${phase} ${target}` : phase;

    if (COMPILES.has(action)) {
      const batch = SWIFT_BATCH.exec(line)?.[1];
      compiled += batch ? unescape(batch).split(",").length : 1;
      return `${withTarget("Compiling")} · ${plural(compiled, "file")}`;
    }
    if (PRECOMPILES.has(action)) {
      precompiled += 1;
      return `Precompiling modules · ${precompiled}`;
    }
    if (action === "PhaseScriptExecution") {
      const script = unescape(SCRIPT.exec(line)?.[1] ?? "");
      if (script === "Bundle React Native code and images") {
        return "Bundling JavaScript";
      }
      return script ? `Running ${script}` : withTarget("Running a script");
    }
    const phase = ACTIONS[action];
    if (phase) return withTarget(phase);
    if (line === "Prepare packages" || line.startsWith("Resolve Package")) {
      return "Resolving packages";
    }
    if (line === "ComputeTargetDependencyGraph") return "Planning the build";
    return undefined;
  };
};

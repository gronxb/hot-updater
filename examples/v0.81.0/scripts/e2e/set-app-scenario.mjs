import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_PATH = path.resolve(__dirname, "../../App.tsx");
const CRASH_GUARD_START = "/* E2E_CRASH_GUARD_START */";
const CRASH_GUARD_END = "/* E2E_CRASH_GUARD_END */";
const CRASH_GUARD_PATTERN =
  /\/\* E2E_CRASH_GUARD_START \*\/[\s\S]*?\/\* E2E_CRASH_GUARD_END \*\//;
const MARKER_PATTERN = /const E2E_SCENARIO_MARKER = ".*?";/;

export async function applyAppScenario({
  appPath = DEFAULT_APP_PATH,
  marker = "__BUILTIN__",
  mode = "reset",
  safeBundleIds = [],
} = {}) {
  const source = await fs.readFile(appPath, "utf8");

  if (!MARKER_PATTERN.test(source)) {
    throw new Error("Failed to locate E2E scenario marker in App.tsx");
  }

  if (!CRASH_GUARD_PATTERN.test(source)) {
    throw new Error("Failed to locate E2E crash guard markers in App.tsx");
  }

  const crashGuardSource =
    mode === "crash"
      ? [
          CRASH_GUARD_START,
          `  const E2E_SAFE_BUNDLE_IDS = new Set(${JSON.stringify(safeBundleIds, null, 2)});`,
          "  const E2E_CURRENT_BUNDLE_ID = HotUpdater.getBundleId();",
          "",
          "  if (!E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {",
          '    throw new Error("hot-updater e2e crash bundle");',
          "  }",
          `  ${CRASH_GUARD_END}`,
        ].join("\n")
      : `${CRASH_GUARD_START}\n  ${CRASH_GUARD_END}`;

  const nextSource = source
    .replace(
      MARKER_PATTERN,
      `const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`,
    )
    .replace(CRASH_GUARD_PATTERN, crashGuardSource);

  await fs.writeFile(appPath, nextSource);
}

function parseCliArgs(argv) {
  const [mode = "reset", ...rawArgs] = argv;
  const options = Object.fromEntries(
    rawArgs.map((arg) => {
      const [rawKey, ...rawValue] = arg.split("=");
      return [rawKey.replace(/^--/, ""), rawValue.join("=")];
    }),
  );

  return {
    mode,
    marker: options.marker,
    safeBundleIds: (options.safeBundleIds || "")
      .split(",")
      .map((bundleId) => bundleId.trim())
      .filter(Boolean),
  };
}

const isDirectInvocation =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectInvocation) {
  await applyAppScenario(parseCliArgs(process.argv.slice(2)));
}

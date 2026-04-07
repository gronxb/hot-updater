import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const usage = `Usage:
  pnpm bench:lambda:memory
  pnpm bench:lambda:memory -- --commit-hash <commit-ish>

Options:
  --commit-hash <commit-ish>  Compare current checkout against the given commit
  --help, -h                  Show this message
`;

const rawArgs = process.argv.slice(2);

const parseArgs = (args) => {
  const forward = [];
  let commitHash;
  let showHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--commit-hash") {
      commitHash = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--commit-hash=")) {
      commitHash = arg.slice("--commit-hash=".length);
      continue;
    }

    forward.push(arg);
  }

  if (commitHash === "") {
    commitHash = undefined;
  }

  return {
    commitHash,
    forward,
    showHelp,
  };
};

const workspaceRoots = ["packages", "plugins", "examples-server"];
const sourceEntryCandidates = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.mts",
  "src/index.js",
  "src/index.mjs",
  "index.ts",
  "index.js",
];

const runPnpm = async (args, cwd, env = {}) => {
  await execa(pnpmCmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
      ...env,
    },
  });
};

const runGit = async (args) => {
  const { stdout } = await execa("git", args, {
    cwd: rootDir,
  });
  return stdout.trim();
};

const ensureWorktree = async (commitHash) => {
  const resolvedHash = await runGit(["rev-parse", "--verify", commitHash]);
  const shortHash = resolvedHash.slice(0, 12);
  const worktreeDir = path.join(
    os.tmpdir(),
    "hot-updater-bench-worktrees",
    `hot-updater3-${shortHash}`,
  );

  let hasWorktree = false;
  try {
    await fs.access(path.join(worktreeDir, ".git"));
    hasWorktree = true;
  } catch {
    hasWorktree = false;
  }

  if (!hasWorktree) {
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
    await execa(
      "git",
      ["worktree", "add", "--detach", worktreeDir, resolvedHash],
      {
        cwd: rootDir,
        stdio: "inherit",
      },
    );
  }

  const installedFlag = path.join(worktreeDir, ".bench-install-complete");
  try {
    await fs.access(installedFlag);
  } catch {
    await runPnpm(
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      worktreeDir,
    );
    await fs.writeFile(installedFlag, `${Date.now()}\n`, "utf8");
  }

  return {
    resolvedHash,
    shortHash,
    worktreeDir,
  };
};

const collectWorkspaceAliases = async (targetRoot) => {
  const aliases = [];

  for (const workspaceRoot of workspaceRoots) {
    const workspacePath = path.join(targetRoot, workspaceRoot);
    let entries = [];

    try {
      entries = await fs.readdir(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageDir = path.join(workspacePath, entry.name);
      const packageJsonPath = path.join(packageDir, "package.json");

      try {
        const packageJson = JSON.parse(
          await fs.readFile(packageJsonPath, "utf8"),
        );
        const packageName = packageJson.name;

        if (!packageName) {
          continue;
        }

        for (const candidate of sourceEntryCandidates) {
          const candidatePath = path.join(packageDir, candidate);

          try {
            await fs.access(candidatePath);
            const sourceDir = path.dirname(candidatePath);
            aliases.push({
              packageName,
              entryPath: candidatePath,
              sourceDir,
            });
            break;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  }

  return aliases;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createStandaloneVitestConfig = async (targetRoot) => {
  const aliasMap = await collectWorkspaceAliases(targetRoot);
  const configPath = path.join(targetRoot, ".bench-memory-vitest.config.mjs");
  const aliasSource = aliasMap
    .map(({ packageName, entryPath, sourceDir }) => {
      const exactPattern = `^${escapeRegex(packageName)}$`;
      const prefixPattern = `^${escapeRegex(packageName)}/(.*)$`;
      return `{
      find: new RegExp(${JSON.stringify(exactPattern)}),
      replacement: ${JSON.stringify(entryPath)},
    },
    {
      find: new RegExp(${JSON.stringify(prefixPattern)}),
      replacement: ${JSON.stringify(`${sourceDir}/$1`)},
    }`;
    })
    .join(",\n    ");
  const configSource = `import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
    ${aliasSource}
    ],
  },
  test: {
    environment: "node",
  },
});
`;

  await fs.writeFile(configPath, configSource, "utf8");
  return configPath;
};

const collectFilesToMirror = (forwardArgs) => {
  return forwardArgs
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.resolve(rootDir, arg));
};

const syncFilesToWorktree = async (worktreeDir, files) => {
  for (const sourcePath of files) {
    const relativePath = path.relative(rootDir, sourcePath);
    const targetPath = path.join(worktreeDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
};

const runMemorySpec = async ({ cwd, configPath, forward, outputPath }) => {
  await fs.rm(outputPath, { force: true });

  await runPnpm(
    [
      "vitest",
      "run",
      "--run",
      "-c",
      configPath,
      "--no-file-parallelism",
      "--maxWorkers",
      "1",
      "--pool",
      "forks",
      "--reporter",
      "dot",
      "--silent",
      "passed-only",
      "--testTimeout",
      "120000",
      "--execArgv=--expose-gc",
      ...forward,
    ],
    cwd,
    {
      HOT_UPDATER_MEMORY_OUTPUT: outputPath,
    },
  );

  return JSON.parse(await fs.readFile(outputPath, "utf8"));
};

const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const formatComparison = (currentValue, baselineValue, preferredDirection) => {
  if (baselineValue === currentValue) {
    return "no change";
  }

  if (baselineValue === 0) {
    return preferredDirection === "lower" ? "baseline was 0" : "baseline was 0";
  }

  const ratio = currentValue / baselineValue;

  if (preferredDirection === "lower") {
    if (ratio < 1) {
      return `${((1 - ratio) * 100).toFixed(1)}% lower`;
    }
    return `${((ratio - 1) * 100).toFixed(1)}% higher`;
  }

  if (ratio > 1) {
    return `${((ratio - 1) * 100).toFixed(1)}% higher`;
  }

  return `${((1 - ratio) * 100).toFixed(1)}% lower`;
};

const printSingleReport = (label, report) => {
  console.log(`Memory report: ${label}`);

  for (const [scenario, metrics] of Object.entries(report.scenarios ?? {})) {
    console.log(`  ${scenario}`);
    console.log(
      `    peak heap delta: ${formatMegabytes(metrics.peakHeapDeltaBytes)}`,
    );
    console.log(
      `    peak rss delta: ${formatMegabytes(metrics.peakRssDeltaBytes)}`,
    );
    console.log(
      `    final heap delta: ${formatMegabytes(metrics.finalHeapDeltaBytes)}`,
    );
    console.log(
      `    final rss delta: ${formatMegabytes(metrics.finalRssDeltaBytes)}`,
    );
  }
};

const printComparison = ({ baselineLabel, baselineReport, currentReport }) => {
  console.log(`\nCross-commit memory summary vs ${baselineLabel}`);

  for (const [scenario, currentMetrics] of Object.entries(
    currentReport.scenarios ?? {},
  )) {
    const baselineMetrics = baselineReport.scenarios?.[scenario];
    if (!baselineMetrics) {
      continue;
    }

    console.log(`  ${scenario}`);
    console.log(
      `    peak heap delta: ${formatMegabytes(currentMetrics.peakHeapDeltaBytes)} (${formatComparison(currentMetrics.peakHeapDeltaBytes, baselineMetrics.peakHeapDeltaBytes, "lower")})`,
    );
    console.log(
      `    peak rss delta: ${formatMegabytes(currentMetrics.peakRssDeltaBytes)} (${formatComparison(currentMetrics.peakRssDeltaBytes, baselineMetrics.peakRssDeltaBytes, "lower")})`,
    );
    console.log(
      `    final heap delta: ${formatMegabytes(currentMetrics.finalHeapDeltaBytes)} (${formatComparison(currentMetrics.finalHeapDeltaBytes, baselineMetrics.finalHeapDeltaBytes, "lower")})`,
    );
    console.log(
      `    final rss delta: ${formatMegabytes(currentMetrics.finalRssDeltaBytes)} (${formatComparison(currentMetrics.finalRssDeltaBytes, baselineMetrics.finalRssDeltaBytes, "lower")})`,
    );
  }
};

const main = async () => {
  const { commitHash, forward, showHelp } = parseArgs(rawArgs);

  if (showHelp) {
    process.stdout.write(usage);
    return;
  }

  const filesToMirror = collectFilesToMirror(forward);
  if (filesToMirror.length === 0) {
    throw new Error("Provide at least one Vitest memory spec file.");
  }

  const currentConfigPath = await createStandaloneVitestConfig(rootDir);
  const currentOutputPath = path.join(
    os.tmpdir(),
    `hot-updater-memory-current-${process.pid}.json`,
  );
  const currentReport = await runMemorySpec({
    cwd: rootDir,
    configPath: currentConfigPath,
    forward,
    outputPath: currentOutputPath,
  });

  if (!commitHash) {
    printSingleReport("current checkout", currentReport);
    return;
  }

  const { resolvedHash, shortHash, worktreeDir } =
    await ensureWorktree(commitHash);
  await syncFilesToWorktree(worktreeDir, filesToMirror);

  const baselineConfigPath = await createStandaloneVitestConfig(worktreeDir);
  const baselineOutputPath = path.join(
    os.tmpdir(),
    `hot-updater-memory-${shortHash}.json`,
  );
  const baselineForward = forward.map((arg) =>
    arg.startsWith("-")
      ? arg
      : path.relative(rootDir, path.resolve(rootDir, arg)),
  );
  const baselineReport = await runMemorySpec({
    cwd: worktreeDir,
    configPath: baselineConfigPath,
    forward: baselineForward,
    outputPath: baselineOutputPath,
  });

  printSingleReport("current checkout", currentReport);
  printComparison({
    baselineLabel: resolvedHash.slice(0, 12),
    baselineReport,
    currentReport,
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

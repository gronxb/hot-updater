import { execa } from "execa";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const usage = `Usage:
  pnpm bench
  pnpm bench -- --commit-hash <commit-ish>
  pnpm bench:update-check -- --commit-hash <commit-ish>

Options:
  --commit-hash <commit-ish>  Compare current checkout against the given commit
  --help, -h                  Show this message

Examples:
  pnpm bench
  pnpm bench -- --commit-hash HEAD~1
  pnpm bench:update-check -- --commit-hash 1a2b3c4d
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

const ensureRunMode = (args) => {
  if (args.includes("--run") || args.includes("--watch") || args.includes("-w")) {
    return args;
  }

  return [...args, "--run"];
};

const hasArgValue = (args, flag) => {
  return (
    args.includes(flag) ||
    args.some((arg) => arg.startsWith(`${flag}=`))
  );
};

const runPnpm = async (args, cwd) => {
  await execa(pnpmCmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
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
    await execa("git", ["worktree", "add", "--detach", worktreeDir, resolvedHash], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  const installedFlag = path.join(worktreeDir, ".bench-install-complete");
  try {
    await fs.access(installedFlag);
  } catch {
    await runPnpm(["install", "--frozen-lockfile", "--ignore-scripts"], worktreeDir);
    await fs.writeFile(installedFlag, `${Date.now()}\n`, "utf8");
  }

  return {
    resolvedHash,
    shortHash,
    worktreeDir,
  };
};

const benchFilePattern = /\.(bench|benchmark)\.[cm]?[jt]sx?$/;

const listBenchFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "dist"
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listBenchFiles(fullPath)));
      continue;
    }

    if (benchFilePattern.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
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

const collectWorkspaceAliases = async (targetRoot) => {
  const aliases = {};

  for (const workspaceRoot of workspaceRoots) {
    const workspacePath = path.join(rootDir, workspaceRoot);
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
            aliases[packageName] = path.join(
              targetRoot,
              path.relative(rootDir, candidatePath),
            );
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

const createBaselineVitestConfig = async (worktreeDir) => {
  const aliasMap = await collectWorkspaceAliases(worktreeDir);
  const configPath = path.join(worktreeDir, ".bench-vitest.config.mjs");
  const configSource = `import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: ${JSON.stringify(aliasMap, null, 2)},
  },
});
`;

  await fs.writeFile(configPath, configSource, "utf8");
  return configPath;
};

const loadBenchmarks = async (jsonPath, baseDir) => {
  const report = JSON.parse(await fs.readFile(jsonPath, "utf8"));
  const normalizedBaseDir = await fs.realpath(baseDir);
  const benchmarks = new Map();

  for (const file of report.files ?? []) {
    let normalizedFilepath = file.filepath;
    try {
      normalizedFilepath = await fs.realpath(file.filepath);
    } catch {
      normalizedFilepath = file.filepath;
    }
    const relativeFilepath = path.relative(normalizedBaseDir, normalizedFilepath);
    for (const group of file.groups ?? []) {
      for (const benchmark of group.benchmarks ?? []) {
        if (typeof benchmark.mean !== "number" || !Number.isFinite(benchmark.mean)) {
          continue;
        }

        const key = `${relativeFilepath}::${benchmark.name}`;
        benchmarks.set(key, benchmark);
      }
    }
  }

  return benchmarks;
};

const printCrossCommitSummary = async ({
  baselineLabel,
  baselineJsonPath,
  baselineRoot,
  currentJsonPath,
}) => {
  const baselineBenchmarks = await loadBenchmarks(baselineJsonPath, baselineRoot);
  const currentBenchmarks = await loadBenchmarks(currentJsonPath, rootDir);
  const sharedKeys = [...currentBenchmarks.keys()].filter((key) =>
    baselineBenchmarks.has(key),
  );

  if (sharedKeys.length === 0) {
    console.log("No matching benchmark names were found for cross-commit comparison.");
    return;
  }

  console.log("\nCross-commit summary");

  for (const key of sharedKeys.sort()) {
    const baseline = baselineBenchmarks.get(key);
    const current = currentBenchmarks.get(key);
    const [relativeFilepath, benchmarkName] = key.split("::");
    const ratio = baseline.mean / current.mean;

    if (ratio >= 1) {
      console.log(
        `  ${relativeFilepath} :: ${benchmarkName}: ${ratio.toFixed(2)}x faster than ${baselineLabel}`,
      );
    } else {
      console.log(
        `  ${relativeFilepath} :: ${benchmarkName}: ${(1 / ratio).toFixed(2)}x slower than ${baselineLabel}`,
      );
    }
  }
};

const collectBenchFilesToMirror = async (forwardArgs) => {
  const positionalArgs = forwardArgs.filter((arg) => !arg.startsWith("-"));
  const explicitBenchFiles = positionalArgs
    .filter((arg) => benchFilePattern.test(arg) && !arg.includes("*"))
    .map((arg) => path.resolve(rootDir, arg));

  if (explicitBenchFiles.length > 0) {
    return explicitBenchFiles;
  }

  return listBenchFiles(rootDir);
};

const syncBenchFilesToWorktree = async (worktreeDir, files) => {
  for (const sourcePath of files) {
    const relativePath = path.relative(rootDir, sourcePath);
    const targetPath = path.join(worktreeDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
};

const main = async () => {
  const { commitHash, forward, showHelp } = parseArgs(rawArgs);

  if (showHelp) {
    process.stdout.write(usage);
    return;
  }

  if (!commitHash) {
    await runPnpm(["vitest", "bench", ...ensureRunMode(forward)], rootDir);
    return;
  }

  if (hasArgValue(forward, "--compare")) {
    throw new Error("--compare cannot be used together with --commit-hash");
  }

  const { resolvedHash, shortHash, worktreeDir } = await ensureWorktree(commitHash);
  const filesToMirror = await collectBenchFilesToMirror(forward);
  const baselineConfigPath = await createBaselineVitestConfig(worktreeDir);
  const baselineFile = path.join(
    os.tmpdir(),
    `hot-updater-bench-${shortHash}.json`,
  );
  const currentFile = path.join(
    os.tmpdir(),
    `hot-updater-bench-current-${shortHash}.json`,
  );

  await syncBenchFilesToWorktree(worktreeDir, filesToMirror);

  console.log(`Baseline commit: ${resolvedHash}`);
  console.log(`Baseline worktree: ${worktreeDir}`);

  await runPnpm(
    [
      "vitest",
      "bench",
      ...ensureRunMode([
        "-c",
        baselineConfigPath,
        ...forward,
        "--outputJson",
        baselineFile,
      ]),
    ],
    worktreeDir,
  );

  await runPnpm(
    [
      "vitest",
      "bench",
      ...ensureRunMode([
        ...forward,
        "--compare",
        baselineFile,
        "--outputJson",
        currentFile,
      ]),
    ],
    rootDir,
  );

  await printCrossCommitSummary({
    baselineLabel: resolvedHash.slice(0, 12),
    baselineJsonPath: baselineFile,
    baselineRoot: worktreeDir,
    currentJsonPath: currentFile,
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

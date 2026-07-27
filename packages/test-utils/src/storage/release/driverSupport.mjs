import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export const readJson = (filePath) =>
  JSON.parse(readFileSync(filePath, "utf8"));

export const parseArguments = (argv) => {
  const options = { simulatePaths: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      value === undefined
    ) {
      throw new TypeError("Every release-driver option requires a value.");
    }
    const name = flag.slice(2);
    if (name === "simulate-path") {
      options.simulatePaths.push(value);
    } else {
      if (options[name] !== undefined) {
        throw new TypeError(`Duplicate release-driver option: ${flag}`);
      }
      options[name] = value;
    }
  }
  return options;
};

export const runCommand = (argv, cwd) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  return {
    argv,
    exitCode: result.status ?? 1,
    stdoutSha256: sha256(result.stdout ?? ""),
    stderrSha256: sha256(result.stderr ?? ""),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export const currentSha = (workspace) => {
  const command = runCommand(["git", "rev-parse", "HEAD"], workspace);
  if (command.exitCode !== 0) {
    throw new TypeError("Unable to resolve the tested commit SHA.");
  }
  const observedSha = command.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(observedSha)) {
    throw new TypeError("The tested commit SHA is malformed.");
  }
  return observedSha;
};

export const writeReceipt = ({
  output,
  mode,
  observedSha,
  verdict,
  commands,
  details,
}) => {
  if (existsSync(output)) {
    throw new TypeError(`Release-driver output already exists: ${output}`);
  }
  mkdirSync(path.dirname(output), { recursive: true });
  const receipt = {
    schema: "hot-updater.storage-v2-verifier/v1",
    mode,
    observedSha,
    verdict,
    commands: commands.map(
      ({ argv, exitCode, stdoutSha256, stderrSha256 }) => ({
        argv,
        exitCode,
        stdoutSha256,
        stderrSha256,
      }),
    ),
    details,
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
};

export const invariant = (condition, detail) => {
  if (!condition) {
    throw new TypeError(detail);
  }
};

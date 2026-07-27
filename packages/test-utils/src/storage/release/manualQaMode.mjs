import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { invariant, runCommand, sha256 } from "./driverSupport.mjs";
import {
  archiveManualQaTarballs,
  assertManualQaArchiveHandoffAvailable,
  assertManualQaArchiveAvailable,
  discardManualQaTarballArchive,
} from "./manualQaArchive.mjs";
import {
  legacyConfig,
  legacyScenario,
  mockScenario,
  standaloneScenario,
  workerScenario,
} from "./manualQaScenarios.mjs";

const PACKAGES = {
  core: "packages/core",
  js: "plugins/js",
  "plugin-core": "plugins/plugin-core",
  mock: "plugins/mock",
  "cli-tools": "packages/cli-tools",
  analytics: "packages/analytics",
  "better-auth": "packages/better-auth",
  server: "packages/server",
  cloudflare: "plugins/cloudflare",
  standalone: "plugins/standalone",
};

const requireSuccess = (command, detail) => {
  invariant(command.exitCode === 0, `${detail}: ${command.stderr}`);
  return command;
};

export const runManualQaMode = ({ workspace, output, archiveDestination }) => {
  const archiveDirectory = assertManualQaArchiveAvailable(output);
  const archiveHandoff =
    archiveDestination === undefined
      ? undefined
      : assertManualQaArchiveHandoffAvailable({
          sourceRoot: path.dirname(output),
          destinationRoot: archiveDestination,
        });
  const root = mkdtempSync(path.join(tmpdir(), "hot-updater-storage-v2-qa-"));
  const tarballDirectory = path.join(root, "tarballs");
  const commands = [];
  const tarballs = new Map();
  const consumers = [];

  try {
    for (const [name, source] of Object.entries(PACKAGES)) {
      const build = requireSuccess(
        runCommand(
          ["pnpm", "--dir", path.join(workspace, source), "build"],
          workspace,
        ),
        `Building ${name} failed`,
      );
      commands.push(build);
    }

    for (const [name, source] of Object.entries(PACKAGES)) {
      const before = new Set(
        existsSync(tarballDirectory) ? readdirSync(tarballDirectory) : [],
      );
      const pack = requireSuccess(
        runCommand(
          [
            "pnpm",
            "--dir",
            path.join(workspace, source),
            "pack",
            "--pack-destination",
            tarballDirectory,
          ],
          workspace,
        ),
        `Packing ${name} failed`,
      );
      commands.push(pack);
      const archive = readdirSync(tarballDirectory).find(
        (entry) => entry.endsWith(".tgz") && !before.has(entry),
      );
      invariant(archive !== undefined, `Packing ${name} produced no tarball.`);
      tarballs.set(name, path.join(tarballDirectory, archive));
    }

    const durableTarballs = archiveManualQaTarballs({
      archiveDirectory,
      tarballs,
    });
    invariant(
      durableTarballs.size === Object.keys(PACKAGES).length,
      "Manual-QA tarball archive is incomplete.",
    );

    const scenarios = [
      {
        name: "mock",
        packages: ["core", "plugin-core", "mock"],
        source: mockScenario,
      },
      {
        name: "legacy",
        packages: [
          "core",
          "js",
          "plugin-core",
          "analytics",
          "server",
          "cli-tools",
        ],
        source: legacyScenario,
        config: legacyConfig,
      },
      {
        name: "worker",
        packages: [
          "core",
          "js",
          "plugin-core",
          "analytics",
          "better-auth",
          "server",
          "cli-tools",
          "cloudflare",
        ],
        source: workerScenario,
      },
      {
        name: "standalone",
        packages: [
          "core",
          "js",
          "plugin-core",
          "analytics",
          "server",
          "standalone",
        ],
        source: standaloneScenario,
      },
    ];
    const observations = {};
    for (const scenario of scenarios) {
      const consumer = path.join(root, `consumer-${scenario.name}`);
      consumers.push(consumer);
      mkdirSync(consumer);
      const init = requireSuccess(
        runCommand(["npm", "init", "-y"], consumer),
        `Initializing ${scenario.name} consumer failed`,
      );
      commands.push(init);
      const archives = scenario.packages.map((name) =>
        durableTarballs.get(name),
      );
      invariant(
        archives.every((archive) => archive !== undefined),
        "Consumer tarball set is incomplete.",
      );
      const install = requireSuccess(
        runCommand(
          [
            "npm",
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...archives,
          ],
          consumer,
        ),
        `Installing ${scenario.name} tarballs failed`,
      );
      commands.push(install);
      if (scenario.config !== undefined) {
        writeFileSync(
          path.join(consumer, "hot-updater.config.mjs"),
          scenario.config,
        );
      }
      const execute = requireSuccess(
        runCommand(
          [process.execPath, "--input-type=module", "--eval", scenario.source],
          consumer,
        ),
        `Executing ${scenario.name} consumer failed`,
      );
      commands.push(execute);
      observations[scenario.name] = JSON.parse(execute.stdout.trim());
    }

    const tarballHashes = Object.fromEntries(
      [...durableTarballs.entries()].map(([name, archive]) => [
        name,
        {
          path:
            archiveHandoff === undefined
              ? archive
              : path.join(
                  archiveHandoff.destinationRoot,
                  path.relative(archiveHandoff.sourceRoot, archive),
                ),
          sha256: sha256(readFileSync(archive)),
        },
      ]),
    );
    rmSync(root, { force: true, recursive: true });
    return {
      commands,
      details: {
        tarballs: tarballHashes,
        consumers,
        observations,
        cleanup: !existsSync(root),
        openHandles: false,
      },
      archiveHandoff,
    };
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    discardManualQaTarballArchive(archiveDirectory);
    throw error;
  }
};

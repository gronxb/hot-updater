import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { BuildType } from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";
import { type InitProvider, INIT_PROVIDER_PACKAGES } from "../initProviders";

const require = createRequire(import.meta.url);
export const INFRA_BUILDS = ["bare", "rock", "expo"] as const;
export type InfraOperation = "scaffold" | "setup" | "upgrade";

export interface InfraOptions {
  provider?: InitProvider;
  build?: BuildType;
  output?: string;
  json?: boolean;
}

interface InfraTemplate {
  schemaVersion: 1;
  provider: InitProvider;
  cliVersion: string;
  providerVersion: string;
  serverVersion: string;
  infrastructureGeneration: number;
  packages: Record<string, string>;
  requiredInputs: Record<string, string | null>;
  upgradeRequirements: string[];
}

interface InfraManifest extends Omit<InfraTemplate, "packages"> {
  operation: InfraOperation;
  build?: BuildType;
  packages?: Record<string, string>;
  files: Record<string, string>;
}

const AGENT_FILES = ["app", "COMMON.md", "SETUP.md", "ENVIRONMENT.md"];

const EXTRA_INPUT_HELP: Record<string, string> = {
  HOT_UPDATER_SUPABASE_URL: "Selected project's API URL; see ENVIRONMENT.md",
  HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY:
    "Local server-side service-role or secret key; never put it in chat or the app",
  HOT_UPDATER_FIREBASE_STORAGE_BUCKET:
    "Provider-reported default Storage bucket name; do not guess its suffix",
  HOT_UPDATER_API_KEY:
    "Client x-api-key; reuse the existing key or provision it after schema setup",
};

const listFiles = async (root: string, relative = ""): Promise<string[]> => {
  const files: string[] = [];
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported scaffold entry: ${name}`);
  }
  return files;
};

const statIfPresent = (target: string) =>
  lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

export async function scaffoldInfra(
  operation: InfraOperation,
  options: Required<Pick<InfraOptions, "provider">> & InfraOptions,
) {
  const { provider, build } = options;
  const forAgent = operation !== "scaffold";
  const packageRoot = path.dirname(require.resolve("hot-updater/package.json"));
  const source = path.join(packageRoot, "dist/infra-templates", provider);
  const template = await readJson<InfraTemplate>(
    path.join(source, "template.json"),
  );
  const output = path.resolve(
    options.output ??
      path.join(
        "hot-updater-infra",
        provider,
        [operation, build, template.cliVersion].filter(Boolean).join("-"),
      ),
  );
  const result = (status: "created" | "existing") => ({
    status,
    operation,
    provider,
    build,
    output,
    instructions: forAgent
      ? path.join(
          output,
          operation === "upgrade" ? "upgrades/README.md" : "SETUP.md",
        )
      : undefined,
    commonInstructions: forAgent ? path.join(output, "COMMON.md") : undefined,
    manifest: path.join(output, "manifest.json"),
    deployment: forAgent ? path.join(output, "deployment.json") : undefined,
    environment: forAgent ? path.join(output, "ENVIRONMENT.md") : undefined,
    upgradeGuide: path.join(output, "upgrades/README.md"),
    upgradeFiles: template.upgradeRequirements.map((version) => ({
      version,
      path: path.join(output, "upgrades", `${version}.md`),
    })),
    serverVersion: template.serverVersion,
  });

  const existing = await statIfPresent(output);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(
        `Scaffold destination is not a regular directory: ${output}`,
      );
    }
    const manifestPath = path.join(output, "manifest.json");
    const manifestStat = await statIfPresent(manifestPath);
    if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error(
        `Destination already exists without a scaffold manifest. Choose another --output directory: ${output}`,
      );
    }
    const previous = await readJson<InfraManifest>(manifestPath);
    if (
      previous.schemaVersion !== 1 ||
      previous.provider !== provider ||
      previous.operation !== operation ||
      previous.build !== build ||
      previous.cliVersion !== template.cliVersion ||
      previous.providerVersion !== template.providerVersion ||
      previous.serverVersion !== template.serverVersion ||
      !previous.files ||
      typeof previous.files !== "object"
    ) {
      throw new Error(
        `Destination belongs to a different scaffold. Choose another --output directory: ${output}`,
      );
    }
    const expectedFiles = (await listFiles(source))
      .filter((file) => file !== "template.json")
      .filter((file) => forAgent || !AGENT_FILES.includes(file.split("/")[0]!))
      .filter(
        (file) =>
          !INFRA_BUILDS.some(
            (choice) =>
              choice !== build && file.endsWith(`.config.${choice}.ts`),
          ),
      )
      .map((file) => file.replace(`.config.${build}.ts`, ".config.ts"));
    for (const file of [
      ...expectedFiles,
      ".gitignore",
      ...(forAgent ? ["env.example"] : []),
    ]) {
      if (typeof previous.files[file] !== "string") {
        throw new Error(
          `Scaffold manifest is incomplete: ${file}. Choose a fresh --output directory.`,
        );
      }
    }
    const realOutput = await realpath(output);
    for (const file of [
      ...Object.keys(previous.files),
      ...(forAgent ? ["deployment.json"] : []),
    ]) {
      const resolved = path.resolve(output, file);
      if (!resolved.startsWith(`${output}${path.sep}`)) {
        throw new Error(
          "Scaffold manifest contains a path outside its directory.",
        );
      }
      const fileStat = await statIfPresent(resolved);
      if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(
          `Scaffold file is missing or unsafe: ${file}. Generate a fresh --output directory to compare and repair it.`,
        );
      }
      if (!(await realpath(resolved)).startsWith(`${realOutput}${path.sep}`)) {
        throw new Error(
          `Scaffold file resolves outside its directory: ${file}`,
        );
      }
    }
    return result("existing");
  }

  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(
    path.join(path.dirname(output), ".hot-updater-infra-"),
  );
  try {
    await cp(source, staging, { recursive: true });
    if (forAgent) {
      for (const choice of INFRA_BUILDS) {
        for (const basename of ["hot-updater.config", "api-key.config"]) {
          const file = path.join(staging, "app", `${basename}.${choice}.ts`);
          if (choice === build)
            await rename(file, path.join(staging, "app", `${basename}.ts`));
          else await rm(file);
        }
      }
    } else {
      for (const file of AGENT_FILES)
        await rm(path.join(staging, file), { recursive: true });
    }
    await rm(path.join(staging, "template.json"));
    await writeFile(
      path.join(staging, ".gitignore"),
      "node_modules/\n.env*\n!env.example\napi-key.local\n*.pem\n*.zip\n*.secret\n",
    );
    if (forAgent) {
      const configText = await readFile(
        path.join(staging, "app/hot-updater.config.ts"),
        "utf8",
      );
      const inputs = Object.values(
        INIT_PROVIDER_PACKAGES[provider].definition.inputs,
      );
      const keys = new Set([
        ...inputs.map(({ envKey }) => envKey),
        ...[...configText.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map(
          (match) => match[1]!,
        ),
        "HOT_UPDATER_API_KEY",
      ]);
      const envExample = [...keys]
        .map((key) => {
          const input = inputs.find(({ envKey }) => envKey === key);
          const help = input?.help ?? EXTRA_INPUT_HELP[key];
          if (!help)
            throw new Error(`Missing environment guidance for ${key}.`);
          return `# ${help}\n${key}=\n`;
        })
        .join("\n");
      await writeFile(
        path.join(staging, "env.example"),
        "# Read ENVIRONMENT.md for purpose, required/optional conditions, and secure sources.\n# Set only applicable values in your ignored local environment file.\n# Do not paste credentials into chat or copy unused empty credential fields.\n\n" +
          envExample,
      );
    }
    const files = Object.fromEntries(
      await Promise.all(
        (await listFiles(staging)).map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(path.join(staging, file)))
            .digest("hex"),
        ]),
      ),
    );
    const manifest: InfraManifest = {
      ...template,
      operation,
      build,
      files,
      packages: forAgent
        ? Object.fromEntries(
            Object.entries(template.packages).filter(
              ([name]) =>
                !INFRA_BUILDS.some(
                  (choice) =>
                    choice !== build && name === `@hot-updater/${choice}`,
                ),
            ),
          )
        : undefined,
    };
    await writeFile(
      path.join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (forAgent)
      await writeFile(
        path.join(staging, "deployment.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            provider,
            resources: template.requiredInputs,
            baseUrl: null,
            deployedServerVersion: null,
            pendingStep: null,
            verifiedSteps: [],
          },
          null,
          2,
        )}\n`,
      );
    await rename(staging, output);
    return result("created");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function handleInfraScaffold(
  operation: InfraOperation,
  options: InfraOptions,
) {
  try {
    if (!options.provider) throw new Error("Select a --provider to scaffold.");
    const result = await scaffoldInfra(operation, {
      ...options,
      provider: options.provider,
      build: options.build,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        ui.block(
          operation === "scaffold"
            ? "Infrastructure scaffold"
            : `Infrastructure ${operation} scaffold`,
          [
            ui.kv("Status", result.status),
            ui.kv("Provider", result.provider),
            ui.kv("Templates", ui.path(result.output)),
            ui.kv("Manifest", ui.path(result.manifest)),
            ...(result.instructions
              ? [ui.kv("Read", ui.path(result.instructions))]
              : []),
            ...(result.commonInstructions
              ? [ui.kv("Common", ui.path(result.commonInstructions))]
              : []),
            ...(result.deployment
              ? [ui.kv("State", ui.path(result.deployment))]
              : []),
            ...(result.environment
              ? [ui.kv("Environment", ui.path(result.environment))]
              : []),
            ui.kv("Upgrades", ui.path(result.upgradeGuide)),
            operation === "scaffold"
              ? "Fill the template inputs and deploy with your provider tools."
              : "Read the instructions, apply the templates with provider tools, and verify each step.",
          ],
        ),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      console.log(
        JSON.stringify({ status: "error", operation, error: message }),
      );
    else
      console.error(
        ui.block("Scaffolding failed", [ui.line([ui.danger(message)])]),
      );
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import os from "node:os";
import path from "node:path";

import type { BuildType } from "@hot-updater/cli-tools";
import { fitText, withProviderMessages } from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";
import type { InitProvider } from "../initProviders";
import {
  CLIENT_CREDENTIAL_FILE,
  CLIENT_CREDENTIAL_SCRIPT,
  type InfraClientAuth,
  type InfraClientPlugin,
} from "./clientAuth";

const require = createRequire(import.meta.url);
export const INFRA_BUILDS = ["bare", "rock", "expo", "one"] as const;
export type InfraOperation = "scaffold" | "setup" | "upgrade";

export interface InfraOptions {
  provider?: InitProvider;
  build?: BuildType;
  output?: string;
  json?: boolean;
}

/** An input of a provider's init, without its validation. */
export interface InfraTemplateInput {
  envKey: string;
  help: string;
  optional?: boolean;
  requirementHint?: string;
}

export interface InfraTemplate {
  schemaVersion: 1;
  provider: InitProvider;
  cliVersion: string;
  providerVersion: string;
  serverVersion: string;
  infrastructureGeneration: number;
  /** The client-route policy of the plugins the server runs. */
  clientAuth: InfraClientAuth;
  /** The client plugins an app adds for the plugins the server runs. */
  clientPlugins: InfraClientPlugin[];
  /**
   * The inputs the provider's init reads, recorded when this CLI was built,
   * since only init installs the provider package.
   */
  inputs: InfraTemplateInput[];
  packages: Record<string, string>;
  requiredInputs: Record<string, string | null>;
  upgradeRequirements: string[];
}

export interface InfraManifest extends Omit<
  InfraTemplate,
  "inputs" | "packages"
> {
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
};

/** The environment guidance for the credential an app sends to client routes. */
const credentialHelp = ({ credential }: NonNullable<InfraClientAuth>) =>
  `Client ${credential.label} sent in ${credential.header}; reuse the existing one or run app/${CLIENT_CREDENTIAL_SCRIPT} after schema setup`;

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

const infraTemplateSource = (provider: InitProvider) =>
  path.join(
    path.dirname(require.resolve("hot-updater/package.json")),
    "dist/infra-templates",
    provider,
  );

export async function readInfraTemplate(provider: InitProvider) {
  const source = infraTemplateSource(provider);
  const template = await readJson<InfraTemplate>(
    path.join(source, "template.json"),
  );
  return { source, template };
}

/** The inputs `provider`'s init reads, for `init --help`. */
export const readInfraTemplateInputs = (
  provider: InitProvider,
): readonly InfraTemplateInput[] =>
  (
    JSON.parse(
      readFileSync(
        path.join(infraTemplateSource(provider), "template.json"),
        "utf8",
      ),
    ) as InfraTemplate
  ).inputs;

export async function getInfraFiles(
  source: string,
  operation: InfraOperation,
  build?: BuildType,
) {
  const forAgent = operation !== "scaffold";
  return (await listFiles(source))
    .filter((file) => file !== "template.json")
    .filter((file) => forAgent || !AGENT_FILES.includes(file.split("/")[0]!))
    .filter(
      (file) =>
        !INFRA_BUILDS.some(
          (choice) => choice !== build && file.endsWith(`.config.${choice}.ts`),
        ),
    )
    .map((file) => file.replace(`.config.${build}.ts`, ".config.ts"));
}

/**
 * Writes the files `operation` extracts from `template` for `build` into
 * the empty directory `staging`: every file the manifest records, before
 * manifest.json and deployment.json. `scaffoldInfra` and doctor both render
 * with it, so doctor compares a scaffold with exactly what this CLI writes.
 */
export async function renderInfraScaffold(
  {
    source,
    template,
    operation,
    build,
  }: {
    source: string;
    template: InfraTemplate;
    operation: InfraOperation;
    build?: BuildType;
  },
  staging: string,
) {
  const forAgent = operation !== "scaffold";
  const appDir = path.join(staging, "app");
  await cp(source, staging, { recursive: true });
  if (forAgent) {
    for (const choice of INFRA_BUILDS) {
      const file = path.join(appDir, `hot-updater.config.${choice}.ts`);
      if (choice === build)
        await rename(file, path.join(appDir, "hot-updater.config.ts"));
      else await rm(file);
    }
  } else {
    for (const file of AGENT_FILES)
      await rm(path.join(staging, file), { recursive: true });
  }
  await rm(path.join(staging, "template.json"));
  await writeFile(
    path.join(staging, ".gitignore"),
    `node_modules/\n.env*\n!env.example\n${CLIENT_CREDENTIAL_FILE}\n*.pem\n*.zip\n*.secret\n`,
  );
  if (forAgent) {
    // Every variable the app's TypeScript reads, by `process.env` or
    // `secret()`: the config, the credential helper's server definition,
    // and Firestore's migration.
    const appSources = await Promise.all(
      (await readdir(appDir))
        .filter((file) => file.endsWith(".ts"))
        .sort()
        .map((file) => readFile(path.join(appDir, file), "utf8")),
    );
    const { clientAuth, inputs } = template;
    const keys = new Set([
      ...inputs.map(({ envKey }) => envKey),
      ...appSources.flatMap((text) =>
        [
          ...text.matchAll(
            /process\.env\.([A-Z_0-9]+)|\bsecret\("([A-Z_0-9]+)"\)/g,
          ),
        ].map((match) => (match[1] ?? match[2])!),
      ),
      ...(clientAuth === null ? [] : [clientAuth.credential.env]),
    ]);
    const envExample = [...keys]
      .map((key) => {
        const input = inputs.find(({ envKey }) => envKey === key);
        const help =
          input?.help ??
          EXTRA_INPUT_HELP[key] ??
          (clientAuth !== null && key === clientAuth.credential.env
            ? credentialHelp(clientAuth)
            : undefined);
        if (!help) throw new Error(`Missing environment guidance for ${key}.`);
        return `# ${help}\n${key}=\n`;
      })
      .join("\n");
    await writeFile(
      path.join(staging, "env.example"),
      "# Read ENVIRONMENT.md for purpose, required/optional conditions, and secure sources.\n# Set only applicable values in your ignored local environment file.\n# Do not paste credentials into chat or copy unused empty credential fields.\n\n" +
        envExample,
    );
  }
}

/** The sha256 of each file in `dir`, as manifest.json records them. */
export async function hashInfraFiles(
  dir: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await listFiles(dir)).map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(dir, file)))
          .digest("hex"),
      ]),
    ),
  );
}

/**
 * `version` where it stands as a whole version in `text`, not as part of a
 * longer number or prerelease, such as 1.2.0 in 11.2.0 or 1.2.0-rc.1.
 */
const versionPattern = (version: string) =>
  `(?<![0-9.])${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9]|[.+-][0-9A-Za-z])`;

/**
 * The files of the scaffold `manifest` records that differ from what this
 * CLI's `template` extracts for its operation and build, once this CLI's
 * versions read as the manifest's: none when the two differ only in their
 * versions. The manifest's hashes are of the files as extracted, before an
 * agent filled them in. A version string that also stands for something
 * else in a file can only make a file differ, never hide a change.
 */
export async function findInfraTemplateChanges({
  source,
  template,
  manifest,
  include = () => true,
}: {
  source: string;
  template: InfraTemplate;
  manifest: InfraManifest;
  /** The files to compare, such as only what a deployment reads. */
  include?: (file: string) => boolean;
}): Promise<string[]> {
  const versions = new Map<string, string>();
  const pairs: [string | undefined, unknown][] = [
    [template.cliVersion, manifest.cliVersion],
    [template.providerVersion, manifest.providerVersion],
    [template.serverVersion, manifest.serverVersion],
    ...Object.entries(template.packages).map(
      ([name, version]): [string, unknown] => [
        version,
        manifest.packages?.[name],
      ],
    ),
  ];
  for (const [from, to] of pairs) {
    if (to === undefined) continue;
    // One of this CLI's versions can't read as two of the manifest's.
    if (typeof from !== "string" || typeof to !== "string") {
      return ["manifest.json"];
    }
    if ((versions.get(from) ?? to) !== to) return ["manifest.json"];
    versions.set(from, to);
  }
  const changes = [...versions].filter(([from, to]) => from !== to);
  const pattern =
    changes.length === 0
      ? null
      : new RegExp(
          [...changes]
            .map(([from]) => from)
            // The longest first, so 1.2.0-rc.1 is not read as 1.2.0.
            .sort((a, b) => b.length - a.length)
            .map(versionPattern)
            .join("|"),
          "g",
        );
  const staging = await mkdtemp(path.join(os.tmpdir(), "hot-updater-infra-"));
  try {
    await renderInfraScaffold(
      {
        source,
        template,
        operation: manifest.operation,
        build: manifest.build,
      },
      staging,
    );
    if (pattern !== null) {
      for (const file of await listFiles(staging)) {
        const absolute = path.join(staging, file);
        // latin1 keeps every byte: the versions are ASCII.
        const text = await readFile(absolute, "latin1");
        const replaced = text.replace(
          pattern,
          (version) => versions.get(version) ?? version,
        );
        if (replaced !== text) await writeFile(absolute, replaced, "latin1");
      }
    }
    const expected = await hashInfraFiles(staging);
    const recorded = isRecord(manifest.files) ? manifest.files : {};
    return [...new Set([...Object.keys(expected), ...Object.keys(recorded)])]
      .filter((file) => include(file) && expected[file] !== recorded[file])
      .sort();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function scaffoldInfra(
  operation: InfraOperation,
  options: Required<Pick<InfraOptions, "provider">> & InfraOptions,
) {
  const { provider, build } = options;
  const forAgent = operation !== "scaffold";
  const { source, template } = await readInfraTemplate(provider);
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
    doctor: {
      command: "hot-updater",
      args: ["doctor", "--scope", "scaffold", "--infra-dir", output, "--json"],
    },
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
    const expectedFiles = await getInfraFiles(source, operation, build);
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
    await renderInfraScaffold({ source, template, operation, build }, staging);
    const files = await hashInfraFiles(staging);
    // The inputs are for env.example and `init --help`, not the manifest.
    const { inputs: _inputs, ...recorded } = template;
    const manifest: InfraManifest = {
      ...recorded,
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
    else {
      // The templates' directory relative to the project or with `~`, and
      // each file in it relative to it, whole: each is a file to open.
      const file = (value: string) =>
        ui.path(
          value === result.output
            ? ui.fitPath(value, Number.POSITIVE_INFINITY)
            : path.relative(result.output, value),
        );
      console.log(
        fitText(
          ui.block(
            operation === "scaffold"
              ? "Infrastructure scaffold"
              : `Infrastructure ${operation} scaffold`,
            [
              ui.kv("Status", result.status),
              ui.kv("Provider", result.provider),
              ui.kv("Templates", file(result.output)),
              ui.kv("Manifest", file(result.manifest)),
              result.instructions && ui.kv("Read", file(result.instructions)),
              result.commonInstructions &&
                ui.kv("Common", file(result.commonInstructions)),
              result.deployment && ui.kv("State", file(result.deployment)),
              result.environment &&
                ui.kv("Environment", file(result.environment)),
              // An upgrade's instructions are the upgrade guide: named once.
              result.upgradeGuide !== result.instructions &&
                ui.kv("Upgrades", file(result.upgradeGuide)),
              operation === "scaffold"
                ? "Fill the template inputs and deploy with your provider tools."
                : "Apply the templates as Read says, and verify each step.",
            ],
          ),
        ),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      console.log(
        JSON.stringify({ status: "error", operation, error: message }),
      );
    else
      console.error(
        fitText(
          withProviderMessages(
            ui.block("Scaffolding failed", [ui.line([ui.danger(message)])]),
          ),
        ),
      );
    process.exitCode = 1;
  }
}

import fs from "node:fs/promises";

import { p } from "@hot-updater/cli-tools";
import {
  createRemoteConfigAdminApi,
  evaluateRemoteConfig,
  type RemoteConfigAdminApi,
  type RemoteConfigEvaluationContext,
  type RemoteConfigParameterValue,
  type RemoteConfigRule,
  type RemoteConfigTemplate,
  type RemoteConfigTemplateIssue,
  RemoteConfigValidationError,
  type RemoteConfigVersion,
  validateRemoteConfigTemplate,
} from "@hot-updater/server/plugins";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import {
  confirmAction,
  requirePlugin,
  withPluginServer,
} from "./utils/open-server";

export interface RemoteConfigCommandOptions {
  /** The server definition the command line names, such as `src/hotUpdater.ts`. */
  readonly serverPath?: string;
  readonly json?: boolean;
}

export interface RemoteConfigShowOptions extends RemoteConfigCommandOptions {
  /** A published version to show instead of the active one. */
  readonly versionNumber?: number;
}

export interface RemoteConfigVersionsOptions extends RemoteConfigCommandOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RemoteConfigPublishOptions extends RemoteConfigCommandOptions {
  readonly description?: string;
  readonly expectedVersion?: number;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

export interface RemoteConfigRollbackOptions extends RemoteConfigCommandOptions {
  readonly description?: string;
  readonly expectedVersion?: number;
  readonly yes?: boolean;
}

export interface RemoteConfigPreviewOptions extends RemoteConfigCommandOptions {
  readonly platform?: "ios" | "android";
  readonly channel?: string;
  readonly appVersion?: string;
  readonly cohort?: string;
  readonly fingerprintHash?: string;
  /** An ISO 8601 date-time; now without it. */
  readonly at?: string;
  readonly versionNumber?: number;
  /** A template file to preview instead of a published version. */
  readonly file?: string;
}

const REMOTE_CONFIG = {
  id: "remoteConfig",
  call: "remoteConfig()",
  importLine: 'import { remoteConfig } from "hot-updater/plugins"',
  serverImportLine:
    'import { remoteConfig } from "@hot-updater/server/plugins"',
} as const;

/**
 * Runs `run` over Remote Config: the API of the remoteConfig() the server
 * runs, or over standaloneRepository, the server's admin routes, which answer
 * as the API does.
 */
const withRemoteConfig = (
  options: RemoteConfigCommandOptions,
  run: (remoteConfig: RemoteConfigAdminApi) => Promise<void>,
): Promise<void> => {
  if (!options.json) printBanner();
  return withPluginServer(options.serverPath, async (server) => {
    requirePlugin(server, REMOTE_CONFIG);
    await run(
      server.fetchAdmin === undefined
        ? (server.api?.[REMOTE_CONFIG.id] as RemoteConfigAdminApi)
        : createRemoteConfigAdminApi(server.fetchAdmin, {
            unavailable: () =>
              new Error(
                "The server runs without remoteConfig(): its admin API serves no Remote Config routes. Add remoteConfig() to the plugins of createHotUpdater on the server, and deploy it.",
              ),
          }),
    );
  });
};

const printJson = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

const dateText = (ms: number | null): string =>
  ms === null ? "" : new Date(ms).toISOString();

const VALUE_WIDTH = 40;

/** A value as the console shows it, cut to fit a table cell. */
const valueText = (value: RemoteConfigParameterValue): string => {
  if (!("value" in value)) return "In-app default";
  if (value.value.length === 0) return '""';
  const line = value.value.replace(/\s+/gu, " ");
  return line.length > VALUE_WIDTH
    ? `${line.slice(0, VALUE_WIDTH - 1)}…`
    : line;
};

const listText = (values: readonly string[]): string => values.join(", ");

/** A rule in a few words, as the console's condition list says it. */
const ruleText = (rule: RemoteConfigRule): string => {
  switch (rule.type) {
    case "platform":
      return `Platform is ${listText(
        rule.platforms.map((platform) =>
          platform === "ios" ? "iOS" : "Android",
        ),
      )}`;
    case "channel":
      return `Channel is ${listText(rule.channels)}`;
    case "appVersion":
      return `App version ${rule.range}`;
    case "cohort":
      return `Cohort is ${listText(rule.cohorts)}`;
    case "percent":
      return rule.from === 0
        ? `${rule.to}% of installs`
        : `${rule.from}–${rule.to}% of installs`;
    case "fingerprint":
      return `Fingerprint is ${listText(rule.hashes.map((hash) => hash.slice(0, 8)))}`;
    case "dateTime":
      return rule.from !== undefined && rule.to !== undefined
        ? `From ${rule.from} until ${rule.to}`
        : rule.from !== undefined
          ? `From ${rule.from}`
          : `Until ${rule.to ?? ""}`;
  }
};

const formatTemplate = (template: RemoteConfigTemplate): string[] => {
  const parameters = Object.entries(template.parameters);
  return [
    ui.title("Parameters"),
    parameters.length === 0
      ? ui.muted("(no parameters)")
      : ui.table(
          [
            { key: "key", label: "Key", format: ui.id },
            { key: "type", label: "Type", format: ui.muted },
            { key: "default", label: "Default" },
            { key: "conditional", label: "Conditional values" },
          ],
          parameters.map(([key, parameter]) => ({
            key,
            type: parameter.valueType,
            default: valueText(parameter.defaultValue),
            conditional: Object.entries(parameter.conditionalValues ?? {})
              .map(([name, value]) => `${name}: ${valueText(value)}`)
              .join("; "),
          })),
        ),
    ui.title("Conditions"),
    template.conditions.length === 0
      ? ui.muted("(no conditions)")
      : ui.table(
          [
            { key: "name", label: "Name" },
            { key: "rules", label: "Rules", format: ui.muted },
          ],
          template.conditions.map((condition) => ({
            name: condition.name,
            rules: condition.rules.map(ruleText).join(" · "),
          })),
        ),
  ];
};

const versionType = (version: RemoteConfigVersion): string =>
  version.updateType === "ROLLBACK"
    ? `Rollback to v${version.rollbackSource}`
    : "Publish";

export const handleRemoteConfigShow = (
  options: RemoteConfigShowOptions = {},
): Promise<void> =>
  withRemoteConfig(options, async (remoteConfig) => {
    if (options.versionNumber === undefined) {
      const active = await remoteConfig.getActive();
      if (options.json) return printJson(active);
      p.log.message(
        [
          active.version === 0
            ? ui.muted("Nothing is published yet.")
            : ui.block(`Remote Config version ${active.version}`, [
                ui.kv("Published", dateText(active.updatedAtMs)),
              ]),
          ...formatTemplate(active.template),
        ].join("\n"),
      );
      return;
    }
    const detail = await remoteConfig.getVersion(options.versionNumber);
    if (detail === null) {
      throw new Error(
        `Remote Config version ${options.versionNumber} does not exist.`,
      );
    }
    if (options.json) return printJson(detail);
    p.log.message(
      [
        ui.block(`Remote Config version ${detail.version}`, [
          ui.kv("Type", versionType(detail)),
          ui.kv("Note", detail.description),
          ui.kv("Published", dateText(detail.createdAtMs)),
        ]),
        ...formatTemplate(detail.template),
      ].join("\n"),
    );
  });

export const handleRemoteConfigVersions = (
  options: RemoteConfigVersionsOptions = {},
): Promise<void> =>
  withRemoteConfig(options, async (remoteConfig) => {
    const page = await remoteConfig.listVersions({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    if (options.json) return printJson(page);
    if (page.versions.length === 0) {
      p.log.message(ui.muted("Nothing is published yet."));
      return;
    }
    // Every publish and rollback adds a version: the first page starts
    // with the active one.
    const active = options.cursor === undefined ? page.versions[0] : undefined;
    p.log.message(
      ui.table(
        [
          { key: "version", label: "Version", format: ui.version },
          { key: "type", label: "Type" },
          { key: "description", label: "Note" },
          { key: "published", label: "Published", format: ui.muted },
        ],
        page.versions.map((version) => ({
          version: `v${version.version}${version === active ? " (active)" : ""}`,
          type: versionType(version),
          // A rollback's default note repeats its type.
          description:
            version.updateType === "ROLLBACK" &&
            version.description ===
              `Rollback to version ${version.rollbackSource}`
              ? ""
              : (version.description ?? ""),
          published: dateText(version.createdAtMs),
        })),
      ),
    );
    if (page.next !== undefined) {
      p.log.message(ui.muted(`More versions: --cursor ${page.next}`));
    }
  });

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

/** A template from a file, or `-` for stdin, with the version it was read at. */
const readTemplateFile = async (
  file: string,
): Promise<{ readonly template: unknown; readonly version?: number }> => {
  const text =
    file === "-" ? await readStdin() : await fs.readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file === "-" ? "stdin" : file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // What `show --json` prints: the template under `template`, which a
  // template itself never has, and the version it was read at.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.hasOwn(parsed, "template")
  ) {
    const version = Reflect.get(parsed, "version");
    return {
      template: Reflect.get(parsed, "template"),
      ...(typeof version === "number" ? { version } : {}),
    };
  }
  return { template: parsed };
};

const issueLines = (issues: readonly RemoteConfigTemplateIssue[]): string[] =>
  issues.map(({ path, message }) =>
    ui.danger(`  ${path ? `${path}: ` : ""}${message}`),
  );

/** `value` with its objects' keys sorted, so equal templates compare equal. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(Reflect.get(value, key))]),
        )
      : value;

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** What `after` changes against `before`, a line each. */
const describeChanges = (
  before: RemoteConfigTemplate,
  after: RemoteConfigTemplate,
): string[] => {
  const lines: string[] = [];
  const compare = <T>(
    noun: string,
    previous: ReadonlyMap<string, T>,
    next: ReadonlyMap<string, T>,
  ) => {
    for (const [name, value] of next) {
      const old = previous.get(name);
      if (old === undefined) lines.push(ui.success(`+ ${noun} ${name}`));
      else if (!sameJson(old, value)) {
        lines.push(ui.warning(`~ ${noun} ${name}`));
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) lines.push(ui.danger(`- ${noun} ${name}`));
    }
  };
  compare(
    "parameter",
    new Map(Object.entries(before.parameters)),
    new Map(Object.entries(after.parameters)),
  );
  const conditions = (template: RemoteConfigTemplate) =>
    new Map(
      template.conditions.map((condition) => [condition.name, condition]),
    );
  compare("condition", conditions(before), conditions(after));
  const kept = (from: RemoteConfigTemplate, other: RemoteConfigTemplate) =>
    from.conditions
      .map(({ name }) => name)
      .filter((name) => other.conditions.some((c) => c.name === name));
  // The first matching condition wins, so their order is a change too.
  if (!sameJson(kept(before, after), kept(after, before))) {
    lines.push(ui.warning("~ condition order"));
  }
  return lines;
};

const reportConflict = (currentVersion: number, baseVersion: number) => {
  throw new Error(
    `Remote Config version ${currentVersion} was published after version ${baseVersion}. Run hot-updater remote-config show to see it, then publish again.`,
  );
};

const reportPublished = (
  version: RemoteConfigVersion,
  options: RemoteConfigCommandOptions,
) => {
  if (options.json) return printJson({ status: "published", version });
  p.log.message(
    ui.block("Remote Config published", [
      ui.kv("Version", ui.version(`v${version.version}`)),
      ui.kv("Type", versionType(version)),
      ui.kv("Note", version.description),
    ]),
  );
  p.log.info("Apps get it at their next fetch.");
};

/** Prints a template's issues and exits 1. */
const reportInvalid = (
  issues: readonly RemoteConfigTemplateIssue[],
  options: RemoteConfigCommandOptions,
) => {
  process.exitCode = 1;
  if (options.json) return printJson({ status: "invalid", issues });
  p.log.error(["The template is invalid:", ...issueLines(issues)].join("\n"));
};

export const handleRemoteConfigPublish = (
  file: string,
  options: RemoteConfigPublishOptions = {},
): Promise<void> =>
  withRemoteConfig(options, async (remoteConfig) => {
    const read = await readTemplateFile(file);
    let template: RemoteConfigTemplate;
    try {
      template = validateRemoteConfigTemplate(read.template);
    } catch (error) {
      if (!(error instanceof RemoteConfigValidationError)) throw error;
      return reportInvalid(error.issues, options);
    }
    const active = await remoteConfig.getActive();
    const baseVersion =
      options.expectedVersion ?? read.version ?? active.version;
    if (baseVersion === active.version && sameJson(template, active.template)) {
      if (options.json) {
        return printJson({ status: "unchanged", version: active.version });
      }
      p.log.message(
        ui.muted(
          `Remote Config version ${active.version} already has this template. Nothing was published.`,
        ),
      );
      return;
    }
    if (!options.json) {
      const changes = describeChanges(active.template, template);
      p.log.message(
        ui.block(`Changes from version ${active.version}`, [
          ...(changes.length === 0 ? [ui.muted("(none)")] : changes),
        ]),
      );
    }
    if (options.dryRun) {
      if (options.json) {
        printJson({ status: "valid", baseVersion, template });
      } else {
        p.log.info("Dry run: the template is valid. Nothing was published.");
      }
      return;
    }
    if (
      !(await confirmAction(
        `Publish this template as Remote Config version ${active.version + 1}?`,
        options.yes,
      ))
    ) {
      return;
    }
    let result: Awaited<ReturnType<RemoteConfigAdminApi["publish"]>>;
    try {
      result = await remoteConfig.publish({
        template,
        baseVersion,
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
      });
    } catch (error) {
      if (!(error instanceof RemoteConfigValidationError)) throw error;
      return reportInvalid(error.issues, options);
    }
    if (result.status === "conflict") {
      return reportConflict(result.currentVersion, baseVersion);
    }
    reportPublished(result.version, options);
  });

export const handleRemoteConfigRollback = (
  version: number,
  options: RemoteConfigRollbackOptions = {},
): Promise<void> =>
  withRemoteConfig(options, async (remoteConfig) => {
    const baseVersion =
      options.expectedVersion ?? (await remoteConfig.getActive()).version;
    if (
      !(await confirmAction(
        `Publish a copy of Remote Config version ${version} as version ${baseVersion + 1}?`,
        options.yes,
      ))
    ) {
      return;
    }
    const result = await remoteConfig.rollback({
      version,
      baseVersion,
      ...(options.description === undefined
        ? {}
        : { description: options.description }),
    });
    if (result.status === "not_found") {
      throw new Error(`Remote Config version ${version} does not exist.`);
    }
    if (result.status === "conflict") {
      return reportConflict(result.currentVersion, baseVersion);
    }
    reportPublished(result.version, options);
  });

/** When to evaluate: `--at`, or now. */
const evaluationTime = (at: string | undefined): number => {
  if (at === undefined) return Date.now();
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    throw new Error(
      `--at takes an ISO 8601 date-time, such as 2026-10-01T09:00:00Z; got "${at}".`,
    );
  }
  return ms;
};

export const handleRemoteConfigPreview = (
  options: RemoteConfigPreviewOptions = {},
): Promise<void> =>
  withRemoteConfig(options, async (remoteConfig) => {
    const now = evaluationTime(options.at);
    let source: { readonly version: number | null; readonly template: unknown };
    if (options.file !== undefined) {
      source = {
        version: null,
        template: (await readTemplateFile(options.file)).template,
      };
    } else if (options.versionNumber !== undefined) {
      const detail = await remoteConfig.getVersion(options.versionNumber);
      if (detail === null) {
        throw new Error(
          `Remote Config version ${options.versionNumber} does not exist.`,
        );
      }
      source = detail;
    } else {
      source = await remoteConfig.getActive();
    }
    let template: RemoteConfigTemplate;
    try {
      template = validateRemoteConfigTemplate(source.template);
    } catch (error) {
      if (!(error instanceof RemoteConfigValidationError)) throw error;
      return reportInvalid(error.issues, options);
    }
    const context: RemoteConfigEvaluationContext = {
      platform: options.platform ?? null,
      channel: options.channel ?? null,
      appVersion: options.appVersion ?? null,
      cohort: options.cohort ?? null,
      fingerprintHash: options.fingerprintHash ?? null,
      now,
    };
    // As the console's preview: the template evaluated here, so a draft
    // file and an earlier version preview the same way.
    const parameters = evaluateRemoteConfig(template, context);
    if (options.json) {
      return printJson({ version: source.version, parameters });
    }
    const entries = Object.entries(parameters);
    p.log.message(
      entries.length === 0
        ? ui.muted("(no parameters)")
        : ui.table(
            [
              { key: "key", label: "Key", format: ui.id },
              { key: "value", label: "Value" },
              { key: "from", label: "From", format: ui.muted },
            ],
            entries.map(([key, { value, condition }]) => ({
              key,
              value: valueText(
                value === null ? { useInAppDefault: true } : { value },
              ),
              from: condition ?? "Default",
            })),
          ),
    );
  });

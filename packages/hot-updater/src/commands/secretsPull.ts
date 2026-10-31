import fs from "node:fs/promises";
import path from "node:path";

import {
  formatEnvValue,
  getBuildSecretNames,
  getConfiguredAdapter,
  getCwd,
  getDeploySecretNames,
  isReservedVariableName,
  loadConfig,
  MANAGED_CLIENT_CREDENTIAL_ENV,
  mergeEnvContent,
  nonInteractiveReason,
  p,
  parseLoadedEnv,
  readSecrets,
  registerSecretValue,
  secretVariableName,
  writeEnvAtomically,
} from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { isFileUnignoredByGit, isProjectFileTracked } from "../utils/git";
import {
  assertSecretName,
  listNames,
  reportFailure,
  SECRET_KINDS,
} from "./secrets";

/** The env file `secrets pull` writes without `--out`. */
export const DEFAULT_PULL_FILE = ".env.hotupdater";

export interface SecretsPullOptions {
  /** The env file to write, relative to the project; `.env.hotupdater` by default. */
  readonly out?: string;
  /** Exactly the secrets to pull, instead of the config's names. */
  readonly only?: readonly string[];
  /** Replace a value the file holds without asking. */
  readonly force?: boolean;
}

/**
 * The file's text, empty when there is none. A symlink or anything else that
 * isn't a regular file is refused: the secrets would land somewhere the path
 * doesn't say, and the file that replaces it would be another one.
 */
const readEnvTarget = async (target: string, label: string) => {
  const stats = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stats === undefined) return { existed: false, content: "" };
  if (!stats.isFile()) {
    throw new Error(`${label} isn't a regular file.\nPass another --out.`);
  }
  return { existed: true, content: await fs.readFile(target, "utf-8") };
};

/** Asks about each name the file holds another value for: those to replace. */
const askReplacements = async (
  variables: readonly string[],
  label: string,
  adapterName: string,
) => {
  const replacing: string[] = [];
  for (const variable of variables) {
    const answer = await p.confirm({
      message: `Replace ${variable} in ${label} with the value in ${adapterName}?`,
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      throw new Error("Cancelled. Nothing was written.");
    }
    if (answer) replacing.push(variable);
  }
  return replacing;
};

/** A warning that names how the file could get committed, and the fix. */
const warnWhenCommittable = (target: string, label: string) => {
  if (
    isProjectFileTracked({
      cwd: path.dirname(target),
      filePath: path.basename(target),
    })
  ) {
    p.log.warn(
      `${label} is tracked by git.\nUntrack it: ${ui.command(`git rm --cached ${label}`)}`,
    );
    return;
  }
  if (isFileUnignoredByGit(target)) {
    p.log.warn(`${label} isn't gitignored.\nAdd it to .gitignore.`);
  }
};

/**
 * `secrets pull`: the mirror of `secrets import`. It reads names from the
 * config's team `secrets` adapter and writes each under the variable
 * `secret()` and `secrets import` read (`secretVariableName`), in a 0600 env
 * file, merged with what the file holds.
 *
 * - A store is read by name, so the names are the config's: those its
 *   adapters' `secret()`s read and the app's API key, as `secrets import`
 *   stores them, or exactly `--only`'s.
 * - Build credentials are never read. Builds resolve them from the store
 *   whatever the file says, so a copy would only be a private key on disk.
 * - A value the file holds that differs is asked about at a terminal, and
 *   refuses without one unless `--force`. Nothing is written after a refusal.
 * - Values are never printed: every value is masked as soon as it is read.
 */
export const handleSecretsPull = async ({
  out = DEFAULT_PULL_FILE,
  only,
  force = false,
}: SecretsPullOptions = {}): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    if (only?.length === 0) {
      throw new Error("--only takes secret names, comma-separated.");
    }
    for (const name of only ?? []) {
      assertSecretName(name);
    }
    const config = await loadConfig(null);
    const adapter = getConfiguredAdapter(config.secrets);
    if (adapter === undefined) {
      p.log.info(
        "localSecrets() keeps secrets on this machine: nothing to pull.",
      );
      return;
    }

    const cwd = getCwd();
    const target = path.resolve(cwd, out);
    const label = ui.fitPath(target);
    const buildNames = getBuildSecretNames(config);
    const isBuildCredential = (name: string) =>
      buildNames.includes(name) ||
      (SECRET_KINDS as readonly string[]).includes(name);
    const referenced = getDeploySecretNames(config);
    const requested = [
      ...new Set(only ?? [...referenced, MANAGED_CLIENT_CREDENTIAL_ENV]),
    ];
    const skipped = [...new Set(only ?? [...buildNames, ...referenced])].filter(
      isBuildCredential,
    );
    const wanted = requested.filter((name) => !isBuildCredential(name));

    const byVariable = new Map<string, string>();
    for (const name of wanted) {
      const variable = secretVariableName(name);
      if (isReservedVariableName(variable)) {
        throw new Error(
          `${variable} can't go in an env file.\nIt changes how a process loads code, or the credentials Hot Updater uses.`,
        );
      }
      const other = byVariable.get(variable);
      if (other !== undefined) {
        throw new Error(
          `${other} and ${name} both write ${variable}.\nPull one with --only.`,
        );
      }
      byVariable.set(variable, name);
    }

    const read =
      wanted.length > 0 ? await readSecrets(adapter, wanted, cwd) : {};
    /** The values the store holds by variable, trimmed as import stores them. */
    const held = new Map<string, string>();
    for (const name of wanted) {
      const raw = Object.hasOwn(read, name) ? read[name] : undefined;
      if (typeof raw !== "string") continue;
      // Masked before anything else, so no failure can print it.
      if (raw !== "") registerSecretValue(raw);
      const value = raw.trim();
      if (value !== "") held.set(secretVariableName(name), value);
    }
    const missing = wanted.filter(
      (name) => !held.has(secretVariableName(name)),
    );
    if (only !== undefined && missing.length > 0) {
      throw new Error(
        `${adapter.name} doesn't hold ${listNames(missing)}.\nCheck the names. Nothing was written.`,
      );
    }
    const missingReferenced = missing.filter((name) =>
      referenced.includes(name),
    );
    const skipLine =
      skipped.length > 0
        ? `Skipped ${listNames(skipped)}.\nBuilds read build credentials from the store.`
        : undefined;
    if (held.size === 0) {
      if (missingReferenced.length > 0) {
        throw new Error(
          [
            `${adapter.name} holds none of these:`,
            ...missingReferenced,
            `Store them from an env file: ${ui.command("npx hot-updater secrets import")}`,
          ].join("\n"),
        );
      }
      p.log.info(
        skipLine ??
          `The config names nothing to pull from ${adapter.name}.\nName secrets with --only.`,
      );
      return;
    }

    const { existed, content } = await readEnvTarget(target, label);
    const current = parseLoadedEnv(content);
    const holding = (variable: string) =>
      Object.hasOwn(current, variable) ? (current[variable] ?? "").trim() : "";
    const unchanged = [...held.keys()].filter(
      (variable) => holding(variable) === held.get(variable),
    );
    const differing = [...held.keys()].filter(
      (variable) =>
        holding(variable) !== "" && holding(variable) !== held.get(variable),
    );
    let replacing: readonly string[] = differing;
    if (differing.length > 0 && !force) {
      const reason = nonInteractiveReason();
      if (reason !== undefined) {
        throw new Error(
          [
            `${label} holds another value for ${listNames(differing)}.`,
            `Can't ask ${reason}. Pass --force to replace it.`,
            "Nothing was written.",
          ].join("\n"),
        );
      }
      replacing = await askReplacements(differing, label, adapter.name);
    }
    const kept = differing.filter((variable) => !replacing.includes(variable));

    const updates = new Map<string, string>();
    for (const [variable, value] of held) {
      if (unchanged.includes(variable) || kept.includes(variable)) continue;
      const formatted = formatEnvValue(value);
      if (formatted === undefined) {
        throw new Error(
          `${variable} can't go in an env file: no quoting holds its value.\nNothing was written.`,
        );
      }
      updates.set(variable, formatted);
    }
    const merged = mergeEnvContent(content, updates);
    if (merged === undefined) {
      throw new Error(
        `Can't update ${label}: it has a line this can't follow.\nFix its quoting, or pass another --out.`,
      );
    }
    // A prompt can sit for a while: never overwrite what changed under it.
    if ((await readEnvTarget(target, label)).content !== content) {
      throw new Error(`${label} changed while asking.\nRun this again.`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (updates.size > 0 || !existed) {
      await writeEnvAtomically(target, merged);
    } else if (process.platform !== "win32") {
      // Nothing to write, but the file holds secrets all the same.
      await fs.chmod(target, 0o600);
    }

    if (updates.size > 0) {
      p.log.success(
        ui.block(`Pulled from ${adapter.name} to ${label}`, [
          ...updates.keys(),
        ]),
      );
    }
    if (unchanged.length > 0) {
      p.log.info(ui.block(`Already in ${label}`, unchanged));
    }
    if (kept.length > 0) {
      p.log.info(ui.block(`Kept your value in ${label}`, kept));
    }
    if (missingReferenced.length > 0) {
      p.log.info(ui.block(`Not in ${adapter.name}`, missingReferenced));
    }
    if (skipLine !== undefined) p.log.info(skipLine);
    warnWhenCommittable(target, label);
  });
};

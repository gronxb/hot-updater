import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The secrets the vault scenario stores, by their default names: the
 * variables of `.env.hotupdater`, and the bundle signing key the app's
 * embedded public key verifies.
 */
export const VAULT_DEPLOY_SECRETS = [
  "deploy-credentials",
  "bundle-signing-key",
] as const;

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;

export type RunVaultCommand = (
  args: string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly logName: string;
  },
) => Promise<string>;

/** A console that serves the vault, started for one scenario. */
export interface VaultConsole {
  readonly url: string;
  /**
   * Reads `deploy-credentials` and signs with `bundle-signing-key`: the
   * token CI holds as `HOT_UPDATER_VAULT_TOKEN` and
   * `HOT_UPDATER_SIGNING_TOKEN`.
   */
  readonly deployToken: string;
  /** `.env.hotupdater` as `secrets import` left it, without credentials. */
  readonly importedEnv: string;
  stop(): Promise<void>;
}

/** The one vault token `secrets token create` printed. */
export function vaultTokenOf(output: string): string {
  const tokens = [...new Set(output.match(/hu_vault_[A-Za-z0-9_-]+/g) ?? [])];
  if (tokens.length !== 1) {
    throw new Error(
      `secrets token create printed ${tokens.length} vault tokens, not one.`,
    );
  }
  return tokens[0]!;
}

/** The variable names an env file sets, as `process.loadEnvFile` reads them. */
export function envFileNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) names.add(match[1]!);
  }
  return [...names];
}

/**
 * The config with its `signing` object replaced by `remoteSigning` at the
 * console, which signs with the vault's bundle signing key. Refuses a config
 * whose `signing` is not one object literal, so a deploy never signs with a
 * local key by mistake.
 */
export function withConsoleSigning(source: string, consoleUrl: string): string {
  const pattern = /\bsigning\s*:\s*\{[^{}]*\}/g;
  const found = source.match(pattern)?.length ?? 0;
  if (found !== 1) {
    throw new Error(
      `hot-updater.config.ts sets signing as an object literal ${found} times; the vault deploy replaces exactly one with remoteSigning.`,
    );
  }
  return [
    'import { remoteSigning } from "hot-updater/signing";',
    source.replace(
      pattern,
      `signing: remoteSigning({ endpoint: ${JSON.stringify(consoleUrl)} })`,
    ),
  ].join("\n");
}

/**
 * The environment of a deploy that reaches only the vault: the inherited one
 * without any variable `.env.hotupdater` sets, and the two connection
 * variables with the signing token. The CLI then sets the credentials from
 * the vault's `deploy-credentials` before it loads the config.
 */
export function vaultDeployEnv(
  inherited: NodeJS.ProcessEnv,
  envFileSource: string,
  vault: Pick<VaultConsole, "url" | "deployToken">,
): NodeJS.ProcessEnv {
  const moved = new Set(envFileNames(envFileSource));
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([name]) => !moved.has(name) && !name.startsWith("HOT_UPDATER_VAULT_"),
      ),
    ),
    HOT_UPDATER_CONSOLE_URL: vault.url,
    HOT_UPDATER_VAULT_TOKEN: vault.deployToken,
    HOT_UPDATER_SIGNING_TOKEN: vault.deployToken,
  };
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port for the vault console")),
      );
    });
  });

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
};

/**
 * Starts a console over the vault console project's own PGlite database, as
 * a CI's console runs: migrates it, issues a write token and the deploy
 * token over the database, starts the console with a master key, and
 * stores the bundle signing key and `.env.hotupdater`'s variables through
 * it with the write token.
 */
export async function startVaultConsole(options: {
  /** The CLI the example app installs. */
  readonly cliPath: string;
  /** The console server `hot-updater console` starts. */
  readonly consoleServerPath: string;
  /** The checked-in console project: `hot-updater.config.ts` with `vault()`. */
  readonly projectDir: string;
  /** Where the database, the logs, and the imported env file go. */
  readonly workDir: string;
  /** `.env.hotupdater`'s contents, whose variables the vault takes. */
  readonly envFileSource: string;
  /** The private key whose public key the app embeds. */
  readonly privateKeyPath: string;
  readonly run: RunVaultCommand;
}): Promise<VaultConsole> {
  const {
    cliPath,
    consoleServerPath,
    envFileSource,
    privateKeyPath,
    projectDir,
    run,
    workDir,
  } = options;
  // The CLI reads `.env.hotupdater` from its package root: the store
  // directory is one, so it never reaches the checkout's.
  const storeDir = path.join(workDir, "store");
  await fsPromises.mkdir(storeDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(storeDir, "package.json"),
    '{ "private": true }\n',
  );
  const projectEnv = {
    HOT_UPDATER_E2E_VAULT_DB_PATH: path.join(workDir, "database"),
  };
  const inProject = (logName: string) => ({
    cwd: projectDir,
    env: projectEnv,
    logName,
  });

  // PGlite opens its directory in one process: the database is migrated and
  // the tokens issued before the console opens it.
  await run(
    [cliPath, "db", "migrate", "server.ts", "--yes"],
    inProject("migrate"),
  );
  const issue = async (name: string, actions: string) =>
    vaultTokenOf(
      await run(
        [
          cliPath,
          "secrets",
          "token",
          "create",
          "--name",
          name,
          "--secrets",
          VAULT_DEPLOY_SECRETS.join(","),
          "--actions",
          actions,
        ],
        inProject(`token-${name}`),
      ),
    );
  const setupToken = await issue("e2e-setup", "write");
  const deployToken = await issue("e2e-deploy", "read,sign");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(workDir, "console.log"), "w");
  const child = spawn(process.execPath, [consoleServerPath], {
    cwd: projectDir,
    detached: true,
    env: {
      ...process.env,
      ...projectEnv,
      PORT: String(port),
      NITRO_PORT: String(port),
      NITRO_HOST: "127.0.0.1",
      HOT_UPDATER_VAULT_MASTER_KEY: randomBytes(32).toString("base64"),
    },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  const stop = async () => {
    if (exited || child.pid === undefined) return;
    killGroup(child.pid, "SIGTERM");
    await Promise.race([exit, sleep(STOP_TIMEOUT_MS)]);
    if (!exited) killGroup(child.pid, "SIGKILL");
    await exit;
  };

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (exited) {
        throw new Error(
          `The vault console exited before it became ready. See ${path.join(workDir, "console.log")}`,
        );
      }
      const ready = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      }).then(
        (response) => response.status >= 100,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the vault console at ${url}.`);
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }

    // Writes go through the console, which seals them with its master key.
    const connection = {
      HOT_UPDATER_CONSOLE_URL: url,
      HOT_UPDATER_VAULT_TOKEN: setupToken,
    };
    await run(
      [
        cliPath,
        "secrets",
        "put",
        "bundle-signing-key",
        "--kind",
        "bundle-signing-key",
        "--private-key",
        privateKeyPath,
      ],
      { cwd: storeDir, env: connection, logName: "put-bundle-signing-key" },
    );
    const envFile = path.join(storeDir, ".env.hotupdater");
    await fsPromises.writeFile(envFile, envFileSource, { mode: 0o600 });
    await run([cliPath, "secrets", "import", ".env.hotupdater", "--yes"], {
      cwd: storeDir,
      env: connection,
      logName: "import-env",
    });
    const importedEnv = await fsPromises.readFile(envFile, "utf8");
    return { url, deployToken, importedEnv, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

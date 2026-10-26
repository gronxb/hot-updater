import crypto from "node:crypto";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { p, registerSecretValue } from "@hot-updater/cli-tools";
import { execa } from "execa";

import {
  ASC_INTEGRATIONS_URL,
  type AscTeam,
  type IssueAscApiKey,
  type IssuedAscApiKey,
} from "../ascApiKey";
import { type AscCli, findAscCli } from "./ascCli";

/** An asc command failed; its message is asc's own, which it printed too. */
export class AscCommandError extends Error {
  readonly exitCode: number | undefined;
  constructor(
    message: string,
    exitCode: number | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AscCommandError";
    this.exitCode = exitCode;
  }
}

const TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * A 0700 directory holding asc's whole state for one sign-in (its web
 * session, config, and the downloaded `.p8`), removed by `dispose`, on
 * `exit`, or on a termination signal, so nothing outlives the sign-in.
 */
const createWorkDirectory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-asc-"));
  await fs.chmod(root, 0o700);
  const remove = () => rmSync(root, { force: true, recursive: true });
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    remove();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const stop = () => {
    process.off("exit", remove);
    for (const signal of TERMINATION_SIGNALS) process.off(signal, onSignal);
  };
  process.on("exit", remove);
  for (const signal of TERMINATION_SIGNALS) process.on(signal, onSignal);
  for (const directory of ["home", "session", "keys"]) {
    await fs.mkdir(path.join(root, directory), { mode: 0o700 });
  }
  let disposal: Promise<void> | undefined;
  return {
    root,
    dispose: () => {
      disposal ??= (async () => {
        stop();
        await fs.rm(root, { force: true, recursive: true });
      })();
      return disposal;
    },
  };
};

/**
 * asc's environment: the caller's, without any `ASC_*` variable (such as a
 * saved password, a 2FA code command, or another API key), and with every
 * file asc keeps (home, config, web session) in `root`. Passwords are never
 * stored, the keychain is bypassed, and telemetry is off.
 */
export const ascEnvironment = (
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!name.startsWith("ASC_") && name !== "DO_NOT_TRACK") env[name] = value;
  }
  return {
    ...env,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home", ".config"),
    XDG_CACHE_HOME: path.join(root, "home", ".cache"),
    ASC_CONFIG_PATH: path.join(root, "home", "config.json"),
    ASC_WEB_SESSION_CACHE_DIR: path.join(root, "session"),
    ASC_WEB_SESSION_CACHE_BACKEND: "file",
    ASC_WEB_DONT_STORE_PASSWORD: "1",
    ASC_BYPASS_KEYCHAIN: "1",
    ASC_TELEMETRY_DISABLED: "1",
    ASC_SPINNER_DISABLED: "1",
  };
};

/**
 * The prompts the Apple Account's password and two-factor codes are typed
 * into. Each answers `undefined` when the developer cancels.
 */
export interface AscSignInPrompts {
  password(appleId: string | undefined): Promise<string | undefined>;
  /** `attempt` counts from 1; asc asks again after Apple texts a code. */
  twoFactorCode(attempt: number): Promise<string | undefined>;
}

const answer = (value: string | symbol) =>
  p.isCancel(value) ? undefined : value;

/** Hot Updater's own prompts, so the sign-in looks like the rest of the CLI. */
const cliPrompts: AscSignInPrompts = {
  password: async (appleId) =>
    answer(
      await p.password({
        message: appleId ? `Password of ${appleId}` : "Apple Account password",
        mask: "•",
        validate: (value) => (value ? undefined : "Enter the password."),
      }),
    ),
  twoFactorCode: async (attempt) =>
    answer(
      await p.text({
        message:
          attempt === 1
            ? "Two-factor code from your trusted device (no device at hand? enter any wrong code once, and Apple texts one to your phone)"
            : "Verification code Apple sent to your phone",
        validate: (value) =>
          /^\d{6}$/u.test(value?.trim() ?? "")
            ? undefined
            : "Enter the 6-digit code.",
      }),
    )?.trim(),
};

/** `value` as one word for `sh`. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * A two-factor code command for asc that asks `prompts` in this process:
 * asc runs it when Apple wants a code, and it prints what the developer
 * typed, which it gets over a socket in the 0700 work directory. A
 * cancelled prompt makes it print nothing and fail, which stops the sign-in.
 */
const listenForTwoFactorCodes = async (
  root: string,
  prompts: AscSignInPrompts,
) => {
  const socketPath = path.join(root, "2fa.sock");
  const scriptPath = path.join(root, "two-factor-code.cjs");
  await fs.writeFile(
    scriptPath,
    [
      'const socket = require("node:net").connect(' +
        JSON.stringify(socketPath) +
        ");",
      'let code = "";',
      'socket.on("data", (chunk) => { code += chunk; });',
      'socket.on("end", () => {',
      "  code = code.trim();",
      "  if (!code) process.exit(1);",
      '  process.stdout.write(code + "\\n");',
      "});",
      'socket.on("error", () => process.exit(1));',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  let attempts = 0;
  let cancelled = false;
  const server = net.createServer((socket) => {
    attempts += 1;
    prompts.twoFactorCode(attempts).then(
      (code) => {
        if (!code) cancelled = true;
        socket.end(code ? `${code}\n` : "");
      },
      () => {
        cancelled = true;
        socket.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`,
    cancelled: () => cancelled,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The last line of asc's error output, which names what failed. */
const lastLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

/** What to do about a key asc could not create, by what App Store Connect said. */
const createFailureHint = (stderr: string): string | undefined => {
  if (/agreement/iu.test(stderr)) {
    return "The Apple Developer Program License Agreement has changed: the Account Holder accepts it at https://developer.apple.com/account, then run this again.";
  }
  if (/limit|maximum/iu.test(stderr)) {
    return `The team has as many active API keys as App Store Connect allows: revoke one you no longer use at ${ASC_INTEGRATIONS_URL}, then run this again.`;
  }
  if (
    /account holder|admin|permission|forbidden|not allowed|403/iu.test(stderr)
  ) {
    return "Creating an App Store Connect API key needs the Account Holder or Admin role in the team: sign in with such an Apple Account, or ask one to run this.";
  }
  return undefined;
};

/** A P-256 private key, as App Store Connect issues one, or a thrown error. */
const assertP8 = (p8: string) => {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(p8);
  } catch {
    throw new Error("asc saved a .p8 that is not a private key.");
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new Error("asc saved a .p8 that is not an EC private key.");
  }
};

/**
 * `IssueAscApiKey` with asc, the open-source App Store Connect CLI
 * (https://github.com/rorkai/App-Store-Connect-CLI, MIT):
 *
 * 1. `asc web auth login` signs in with the password and the two-factor
 *    codes typed into Hot Updater's prompts. The password reaches only that
 *    asc process, in its environment (never an argument), each code only
 *    asc's two-factor code command, and neither is kept or printed.
 * 2. `chooseTeam` sees the team asc signed in to, unless `teamId` is set.
 * 3. `asc web api-keys create` issues the key and saves its one-time `.p8`,
 *    which is checked before it is handed out; a key that fails the check is
 *    revoked at once.
 * 4. `revoke` runs `asc web api-keys revoke` in the same session.
 *
 * asc's whole state (its web session, config, and the `.p8`) lives in a
 * temporary 0700 directory, which `dispose` deletes, as does the process
 * exiting first.
 *
 * @param asc The asc binary; found or downloaded with `findAscCli` unless set.
 * @param env The environment asc's own is derived from.
 * @param prompts Where the password and two-factor codes are asked.
 */
export const createAscCliKeyIssuer =
  ({
    asc,
    env = process.env,
    prompts = cliPrompts,
  }: {
    asc?: Pick<AscCli, "path">;
    env?: NodeJS.ProcessEnv;
    prompts?: AscSignInPrompts;
  } = {}): IssueAscApiKey =>
  async ({ name, role, appleId, teamId, chooseTeam }) => {
    const cli = asc ?? (await findAscCli());
    p.log.info(
      "Hot Updater signs in with asc, the open-source App Store Connect CLI. It keeps only the API key it issues: neither the password nor the session.",
    );
    const password = await prompts.password(appleId);
    if (password === undefined) {
      throw new AscCommandError("Signing in was cancelled.", undefined);
    }
    registerSecretValue(password);
    const work = await createWorkDirectory();
    const ascEnv = ascEnvironment(work.root, env);

    // asc asks nothing on this terminal: the password and codes come from
    // Hot Updater's prompts. stdout carries asc's JSON; its error output is
    // kept for messages.
    const run = async (
      step: string,
      args: readonly string[],
      extraEnv: NodeJS.ProcessEnv = {},
    ) => {
      const result = await execa(cli.path, args, {
        env: { ...ascEnv, ...extraEnv },
        extendEnv: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
      });
      const stderr = String(result.stderr ?? "");
      if (result.exitCode !== 0 || result.failed) {
        const reason =
          lastLine(stderr) ??
          (result.signal ? `stopped by ${result.signal}` : undefined) ??
          `exit code ${result.exitCode}`;
        throw new AscCommandError(
          `${step} failed: ${reason}`,
          result.exitCode,
          {
            cause: { stderr },
          },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(result.stdout));
      } catch {
        parsed = undefined;
      }
      if (!isRecord(parsed)) {
        throw new AscCommandError(
          `${step} printed no JSON this version of Hot Updater reads.`,
          result.exitCode,
        );
      }
      return parsed;
    };

    try {
      const twoFactor = await listenForTwoFactorCodes(work.root, prompts);
      let login: Record<string, unknown>;
      try {
        login = await run(
          "Signing in with asc web auth login",
          [
            "web",
            "auth",
            "login",
            ...(appleId ? ["--apple-id", appleId] : []),
            "--two-factor-code-command",
            twoFactor.command,
            "--output",
            "json",
          ],
          { ASC_WEB_PASSWORD: password },
        );
      } catch (error) {
        if (twoFactor.cancelled()) {
          throw new AscCommandError("Signing in was cancelled.", undefined, {
            cause: error,
          });
        }
        throw error;
      } finally {
        await twoFactor.close();
      }
      if (login.authenticated !== true) {
        throw new AscCommandError(
          "asc web auth login finished without a signed-in session.",
          0,
        );
      }
      const signedIn: AscTeam = {
        ...(text(login.appleId) ? { appleId: text(login.appleId) } : {}),
        ...(text(login.publicProviderId)
          ? { teamId: text(login.publicProviderId) }
          : {}),
        ...(text(login.developerTeamId)
          ? { developerTeamId: text(login.developerTeamId) }
          : {}),
      };
      const chosen = teamId ?? (await chooseTeam?.(signedIn));
      const team: AscTeam =
        chosen === undefined || chosen === signedIn.teamId
          ? signedIn
          : {
              ...(signedIn.appleId ? { appleId: signedIn.appleId } : {}),
              teamId: chosen,
            };
      const sessionArgs = [
        ...(signedIn.appleId ? ["--apple-id", signedIn.appleId] : []),
        ...(chosen === undefined ? [] : ["--public-provider-id", chosen]),
      ];

      let created: Record<string, unknown>;
      try {
        created = await run("Creating the App Store Connect API key", [
          "web",
          "api-keys",
          "create",
          "--name",
          name,
          "--role",
          role,
          "--output-dir",
          path.join(work.root, "keys"),
          ...sessionArgs,
          "--output",
          "json",
        ]);
      } catch (error) {
        const stderr =
          error instanceof AscCommandError && isRecord(error.cause)
            ? String(error.cause.stderr ?? "")
            : "";
        const hint = createFailureHint(stderr);
        if (hint && error instanceof AscCommandError) {
          throw new AscCommandError(
            `${error.message}\n${hint}`,
            error.exitCode,
            {
              cause: error,
            },
          );
        }
        throw error;
      }

      const keyId = text(created.keyId);
      if (!keyId) {
        throw new AscCommandError(
          "asc web api-keys create printed no key ID.",
          0,
        );
      }
      const revoke = () =>
        run("Revoking the key", [
          "web",
          "api-keys",
          "revoke",
          "--key-id",
          keyId,
          "--type",
          "team",
          "--confirm",
          ...sessionArgs,
          "--output",
          "json",
        ]).then(
          (json) => json.active === false || json.status === "revoked",
          () => false,
        );

      let p8: string;
      let issuerId: string;
      try {
        const issuer = text(created.issuerId);
        const p8Path = text(created.p8Path);
        const keys = path.join(work.root, "keys");
        if (!issuer) throw new Error("asc printed no issuer ID for the key.");
        if (
          !p8Path ||
          (await fs.realpath(path.dirname(path.resolve(p8Path)))) !==
            (await fs.realpath(keys))
        ) {
          throw new Error(
            "asc saved the key's .p8 outside its output directory.",
          );
        }
        p8 = (await fs.readFile(p8Path, "utf-8")).trim();
        registerSecretValue(p8);
        registerSecretValue(Buffer.from(p8).toString("base64"));
        assertP8(p8);
        issuerId = issuer;
      } catch (error) {
        // A key nothing can use is not handed out, and not left behind.
        const revoked = await revoke();
        throw new Error(
          revoked
            ? `${(error as Error).message} The App Store Connect API key ${keyId} was revoked again.`
            : `${(error as Error).message} Revoking the App Store Connect API key ${keyId} failed too: revoke it at ${ASC_INTEGRATIONS_URL}.`,
          { cause: error },
        );
      }

      const issued: IssuedAscApiKey = {
        p8,
        keyId,
        issuerId,
        name: text(created.name) ?? name,
        team,
        revoke,
        dispose: work.dispose,
      };
      return issued;
    } catch (error) {
      await work.dispose();
      throw error;
    }
  };

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pinnedVersion = "0.21.18";
const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 15_000;
const require = createRequire(import.meta.url);

type Registration = {
  pid: number;
  processStartTime: string;
  httpPort: number;
  token: string;
  version: string;
  transport: "http";
  stateDir: string;
};

export function validateDaemonRegistration(
  value: unknown,
  owner: { pid: number; stateDir: string; processStartTime: string },
): Registration {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // Native JSON parse errors can quote the input, which contains a token.
      throw new Error("Owned daemon registration contains invalid JSON");
    }
  }
  const data = parsed as Partial<Registration> | null;
  if (
    !data ||
    data.pid !== owner.pid ||
    data.stateDir !== owner.stateDir ||
    data.processStartTime !== owner.processStartTime ||
    !owner.processStartTime ||
    data.version !== pinnedVersion ||
    data.transport !== "http" ||
    !Number.isInteger(data.httpPort) ||
    data.httpPort! < 1 ||
    data.httpPort! > 65535 ||
    typeof data.token !== "string" ||
    !/^[a-f0-9]{48}$/.test(data.token)
  ) {
    throw new Error(
      "Owned agent-device daemon registration did not match its process and pinned version",
    );
  }
  return data as Registration;
}

export function validateDaemonShutdown(value: unknown): void {
  const response = value as {
    success?: boolean;
    data?: Record<string, unknown>;
  } | null;
  const data = response?.data;
  const releases = data?.providerReleases as
    | { status?: string; pending?: unknown[] }
    | undefined;
  if (
    response?.success !== true ||
    data?.stopped !== true ||
    data.mode !== "graceful" ||
    data.cleanupConfidence !== "known" ||
    data.clean !== true ||
    releases?.status !== "completed" ||
    !Array.isArray(releases.pending) ||
    releases.pending.length !== 0 ||
    !Array.isArray(data.claimsOrphaned) ||
    data.claimsOrphaned.length !== 0 ||
    !Array.isArray(data.claimsUnattributable) ||
    data.claimsUnattributable.length !== 0
  ) {
    throw new Error(
      "Owned agent-device daemon shutdown did not prove complete cleanup",
    );
  }
}

export function privateDaemonEnvironment(
  env: NodeJS.ProcessEnv,
  stateDir: string,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("AGENT_DEVICE_")),
    ),
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_IOS_RUNNER_DETACH: "0",
  };
}

export async function resolvePinnedAgentDevice() {
  const sdkRequire = createRequire(require.resolve("@e2e-dev/mobile"));
  let packageFile: string | undefined;
  // The dependency exposes import-only entry points, so resolve its package
  // through the SDK's standard node_modules search path instead of globals.
  for (const directory of sdkRequire.resolve.paths("agent-device") ?? []) {
    if (path.basename(directory) !== "node_modules") continue;
    const candidate = path.join(directory, "agent-device/package.json");
    try {
      await fs.access(candidate);
      packageFile = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!packageFile) {
    throw new Error(
      "The mobile SDK's pinned agent-device dependency is missing",
    );
  }
  const info = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (info.name !== "agent-device" || info.version !== pinnedVersion) {
    throw new Error(`The mobile runner requires agent-device ${pinnedVersion}`);
  }
  const root = path.dirname(await fs.realpath(packageFile));
  // This is the exact launch entry used by the pinned SDK's local client.
  // Upgrades must revalidate this internal entry and the HTTP/shutdown contract.
  const launcher = path.join(root, "dist/src/internal/daemon.js");
  const cli = path.join(root, "bin/agent-device.mjs");
  await Promise.all([fs.access(launcher), fs.access(cli)]);
  return { launcher, cli };
}

async function guardLegacyXCTestState(env: NodeJS.ProcessEnv) {
  if (process.platform !== "darwin") return;
  const sharedPath = path.join(
    env.HOME ?? os.homedir(),
    "Library/Developer/XCTestDevices",
  );
  const inspect = (file: string) =>
    fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  const [current, backup] = await Promise.all([
    inspect(sharedPath),
    inspect(`${sharedPath}.agent-device-backup`),
  ]);
  if (current?.isSymbolicLink() || backup) {
    throw new Error(
      "Shared legacy XCTestDevices state requires reconciliation before starting a private daemon",
    );
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolve) => {
    const done = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

// Startup failures never expose the daemon to a client. Only its own process
// group can be stopped here; registration data is never used as a kill target.
async function stopOwnedProcess(
  child: ChildProcess,
  timeoutMs = 2000,
): Promise<void> {
  if (hasExited(child) || !child.pid) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, Math.floor(timeoutMs / 2))) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForExit(child, Math.ceil(timeoutMs / 2))))
    throw new Error("Owned agent-device daemon did not exit");
}

async function processStartTime(pid: number): Promise<string> {
  return (
    await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1000,
    })
  ).stdout.trim();
}

export async function startOwnedAgentDeviceDaemon(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const installation = await resolvePinnedAgentDevice();
  await guardLegacyXCTestState(env);
  signal.throwIfAborted();
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-agent-device-"),
  );
  await fs.chmod(stateDir, 0o700);
  const daemonEnv = privateDaemonEnvironment(env, stateDir);
  const child = spawn(process.execPath, [installation.launcher], {
    env: daemonEnv,
    detached: true,
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const registrationPath = path.join(stateDir, "daemon.json");
  let registration: Registration;
  try {
    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      signal.throwIfAborted();
      if (spawnError || hasExited(child) || !child.pid)
        throw new Error("Owned agent-device daemon exited during startup");
      let raw: string | undefined;
      try {
        raw = await fs.readFile(registrationPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw !== undefined) {
        const mode = (await fs.lstat(registrationPath)).mode & 0o777;
        if (mode !== 0o600)
          throw new Error("Owned daemon registration must be private");
        registration = validateDaemonRegistration(raw, {
          pid: child.pid,
          stateDir,
          processStartTime: await processStartTime(child.pid),
        });
        const response = await fetch(
          `http://127.0.0.1:${registration.httpPort}/health`,
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          },
        );
        const health = (await response.json()) as Record<string, unknown>;
        if (
          !response.ok ||
          health.service !== "agent-device-daemon" ||
          health.version !== pinnedVersion ||
          health.rpcProtocolVersion !== 2 ||
          typeof health.instanceId !== "string" ||
          !health.instanceId
        ) {
          throw new Error(
            "Owned agent-device daemon health protocol is incompatible",
          );
        }
        signal.throwIfAborted();
        break;
      }
      if (Date.now() >= deadline)
        throw new Error("Owned agent-device daemon startup timed out");
      await sleep(50, undefined, { signal });
    }
  } catch (error) {
    await stopOwnedProcess(child);
    await fs.rm(stateDir, { force: true, recursive: true });
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${registration.httpPort}`;
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      const deadline = Date.now() + shutdownTimeoutMs;
      try {
        if (hasExited(child))
          throw new Error("Owned daemon exited before cleanup was verified");
        validateDaemonRegistration(
          await fs.readFile(registrationPath, "utf8"),
          {
            pid: child.pid!,
            stateDir,
            processStartTime: await processStartTime(child.pid!),
          },
        );
        // This public local lifecycle command does not use RPC timeout recovery.
        // --clean releases retained runners only for this daemon's PID/start time.
        const response = await execFileAsync(
          process.execPath,
          [
            installation.cli,
            "daemon",
            "stop",
            "--state-dir",
            stateDir,
            "--clean",
            "--json",
          ],
          {
            env: daemonEnv,
            encoding: "utf8",
            timeout: Math.max(1, deadline - Date.now() - 2000),
            killSignal: "SIGKILL",
          },
        );
        validateDaemonShutdown(JSON.parse(response.stdout));
        if (!(await waitForExit(child, 1000)))
          throw new Error("Owned daemon remained alive after stop");
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch {
        await stopOwnedProcess(child, Math.max(1, deadline - Date.now()));
        throw new Error(
          `Owned agent-device daemon cleanup is uncertain; private state retained at ${stateDir}`,
        );
      }
    })());
  return {
    pid: child.pid!,
    stateDir,
    baseUrl,
    stop,
    // Only the SDK child receives this credential; never persist it as evidence.
    env: {
      ...daemonEnv,
      AGENT_DEVICE_DAEMON_BASE_URL: baseUrl,
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: registration.token,
    },
  };
}

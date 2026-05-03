import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import admin from "firebase-admin";
import fkill from "fkill";

const PROJECT_ID_PREFIX = "hot-updater-test";
const MAX_STARTUP_ATTEMPTS = process.env.CI ? 3 : 2;
const MAX_LOG_LINES = 200;

type EmulatorLogs = {
  stdout: string[];
  stderr: string[];
};

let emulatorProcess: ChildProcessWithoutNullStreams | undefined;
let firestorePort: number | undefined;
let tempConfigDir: string | undefined;
let projectId: string | undefined;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve an available port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function createFirebaseConfig(firestorePort: number): Promise<string> {
  tempConfigDir = await mkdtemp(join(tmpdir(), "hot-updater-firebase-"));
  const configPath = join(tempConfigDir, "firebase.json");

  await writeFile(
    configPath,
    JSON.stringify({
      emulators: {
        singleProjectMode: true,
        firestore: {
          host: "127.0.0.1",
          port: firestorePort,
        },
        ui: {
          enabled: false,
        },
      },
    }),
  );

  return configPath;
}

function appendLog(store: string[], chunk: Buffer) {
  store.push(chunk.toString("utf8"));
  if (store.length > MAX_LOG_LINES) {
    store.shift();
  }
}

function formatEmulatorLogs(logs: EmulatorLogs) {
  return [...logs.stdout, ...logs.stderr].join("").trim();
}

function startEmulatorProcess({
  configPath,
  projectId,
}: {
  configPath: string;
  projectId: string;
}) {
  const child = spawn(
    "pnpm",
    [
      "firebase",
      "emulators:start",
      "--project",
      projectId,
      "--only",
      "firestore",
      "--config",
      configPath,
      "--log-verbosity",
      "QUIET",
    ],
    {
      cwd: __dirname,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs: EmulatorLogs = { stdout: [], stderr: [] };
  child.stdout.on("data", (chunk: Buffer) => {
    appendLog(logs.stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    appendLog(logs.stderr, chunk);
  });

  return {
    child,
    logs,
  };
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  return await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    child.once("exit", onExit);
  });
}

async function stopEmulatorProcess(
  child: ChildProcessWithoutNullStreams,
  port: number | undefined,
) {
  const pid = child.pid;

  if (child.exitCode === null) {
    try {
      if (process.platform !== "win32" && pid) {
        process.kill(-pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }

  const exited = await waitForExit(child, 8_000);

  if (!exited) {
    try {
      if (process.platform !== "win32" && pid) {
        process.kill(-pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {}

    await waitForExit(child, 3_000);
  }

  if (typeof port === "number") {
    await fkill(`:${port}`, {
      force: true,
      silent: true,
    }).catch(() => {});
  }
}

async function waitForEmulator(
  firestore: FirebaseFirestore.Firestore,
  child: ChildProcessWithoutNullStreams,
  logs: EmulatorLogs,
  maxRetries = 20,
  retryDelay = 2000,
): Promise<boolean> {
  let retries = 0;
  while (retries < maxRetries) {
    if (child.exitCode !== null) {
      throw new Error(
        [
          `Firebase emulator exited early with code ${String(child.exitCode)}.`,
          formatEmulatorLogs(logs),
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    try {
      await firestore.listCollections();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (child.exitCode !== null) {
        throw new Error(
          [
            `Firebase emulator exited immediately after startup with code ${String(child.exitCode)}.`,
            formatEmulatorLogs(logs),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
      console.log(`Firebase emulator ready after ${retries + 1} attempt(s)`);
      return true;
    } catch {
      console.log(
        `Waiting for emulator to start (attempt ${retries + 1}/${maxRetries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retries++;
    }
  }
  return false;
}

export async function setup() {
  console.log("Starting Firebase emulator...");

  firestorePort = await getAvailablePort();
  const emulatorHost = `127.0.0.1:${firestorePort}`;
  projectId = `${PROJECT_ID_PREFIX}-${process.pid}-${Date.now()}`;

  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  process.env.GCLOUD_PROJECT = projectId;

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
    });
  }

  const firestore = admin.firestore();
  firestore.settings({
    host: emulatorHost,
    ssl: false,
    ignoreUndefinedProperties: true,
  });

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const firebaseConfigPath = await createFirebaseConfig(firestorePort);
    const runtime = startEmulatorProcess({
      configPath: firebaseConfigPath,
      projectId,
    });
    emulatorProcess = runtime.child;

    try {
      const emulatorReady = await waitForEmulator(
        firestore,
        runtime.child,
        runtime.logs,
      );

      if (!emulatorReady) {
        throw new Error("Firebase emulator did not become ready in time");
      }

      console.log("Firebase emulator started successfully");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `Firebase emulator startup attempt ${attempt}/${MAX_STARTUP_ATTEMPTS} failed`,
      );
      console.error(lastError.message);
      await teardown({ resetState: false });
    }
  }

  throw new Error(
    [
      `Firebase emulator failed to start after ${MAX_STARTUP_ATTEMPTS} attempt(s).`,
      lastError?.message,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

export async function teardown(options?: { resetState?: boolean }) {
  const resetState = options?.resetState ?? true;
  const child = emulatorProcess;
  const port = firestorePort;

  if (child) {
    try {
      await stopEmulatorProcess(child, port);
      console.log("Successfully killed emulator process");
    } catch (error) {
      console.error("Failed to kill emulator process:", error);
    }
  }

  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true });
    tempConfigDir = undefined;
  }

  emulatorProcess = undefined;

  if (resetState) {
    firestorePort = undefined;
    projectId = undefined;
  }
}

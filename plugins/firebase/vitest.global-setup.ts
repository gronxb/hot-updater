import { execa } from "execa";
import admin from "firebase-admin";
import path from "path";

const FIRESTORE_EMULATOR_PORT = 18080;
const FIRESTORE_EMULATOR_HOST = `127.0.0.1:${FIRESTORE_EMULATOR_PORT}`;

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "hot-updater-test",
  });
}

const firestore = admin.firestore();
firestore.settings({
  host: FIRESTORE_EMULATOR_HOST,
  ssl: false,
  ignoreUndefinedProperties: true,
});

let emulatorProcess: ReturnType<typeof execa> | null = null;

async function getListeningPids(port: number): Promise<string[]> {
  const { stdout } = await execa("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    reject: false,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitForPortToClose(
  port: number,
  maxRetries = 20,
  retryDelay = 250,
): Promise<void> {
  for (let retries = 0; retries < maxRetries; retries++) {
    const pids = await getListeningPids(port);
    if (pids.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  throw new Error(`Port ${port} did not close in time`);
}

async function stopExistingEmulator(): Promise<void> {
  if (emulatorProcess) {
    try {
      emulatorProcess.kill("SIGTERM");
      await emulatorProcess.catch(() => {});
    } catch {
      // Ignore process shutdown errors and fall back to port-based cleanup.
    }
    emulatorProcess = null;
  }

  const pids = await getListeningPids(FIRESTORE_EMULATOR_PORT);
  if (pids.length === 0) {
    return;
  }

  await execa("kill", ["-9", ...pids], { reject: false });
  await waitForPortToClose(FIRESTORE_EMULATOR_PORT);
}

async function waitForEmulator(
  maxRetries = 20,
  retryDelay = 2000,
): Promise<boolean> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      await firestore.listCollections();
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

  await stopExistingEmulator();

  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  process.env.GCLOUD_PROJECT = "hot-updater-test";

  emulatorProcess = execa(
    "pnpm",
    [
      "firebase",
      "emulators:start",
      "--only",
      "firestore",
      "--config",
      path.join(__dirname, "firebase.test.json"),
    ],
    {
      cwd: __dirname,
      stdio: "inherit",
      reject: false,
    },
  );

  const emulatorReady = await waitForEmulator();
  if (!emulatorReady) {
    throw new Error("Firebase emulator failed to start");
  }

  console.log("Firebase emulator started successfully");
}

export async function teardown() {
  await stopExistingEmulator();
}

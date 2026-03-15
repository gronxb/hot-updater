import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import admin from "firebase-admin";
import fkill from "fkill";

const PROJECT_ID = "hot-updater-test";

let emulatorProcess: ReturnType<typeof execa> | undefined;
let tempConfigDir: string | undefined;

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
        firestore: {
          host: "127.0.0.1",
          port: firestorePort,
        },
      },
    }),
  );

  return configPath;
}

async function waitForEmulator(
  firestore: FirebaseFirestore.Firestore,
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

  const firestorePort = await getAvailablePort();
  const emulatorHost = `127.0.0.1:${firestorePort}`;

  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  process.env.GCLOUD_PROJECT = PROJECT_ID;

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: PROJECT_ID,
    });
  }

  const firestore = admin.firestore();
  firestore.settings({
    host: emulatorHost,
    ssl: false,
    ignoreUndefinedProperties: true,
  });

  const firebaseConfigPath = await createFirebaseConfig(firestorePort);

  emulatorProcess = execa(
    "pnpm",
    [
      "firebase",
      "emulators:start",
      "--project",
      PROJECT_ID,
      "--only",
      "firestore",
      "--config",
      firebaseConfigPath,
    ],
    {
      cwd: __dirname,
      stdio: "inherit",
      reject: false,
    },
  );

  const emulatorReady = await waitForEmulator(firestore);
  if (!emulatorReady) {
    await teardown();
    throw new Error("Firebase emulator failed to start");
  }

  console.log("Firebase emulator started successfully");
}

export async function teardown() {
  if (emulatorProcess?.pid) {
    try {
      await fkill(emulatorProcess.pid, { force: true });
      console.log("Successfully killed emulator process");
    } catch (error) {
      console.error("Failed to kill emulator process:", error);
    }
  }

  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true });
    tempConfigDir = undefined;
  }
}

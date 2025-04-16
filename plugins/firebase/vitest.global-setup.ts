import { execa } from "execa";
import admin from "firebase-admin";
import fkill from "fkill";

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "hot-updater-test",
  });
}

const firestore = admin.firestore();
firestore.settings({
  host: "localhost:8080",
  ssl: false,
});

let emulatorProcess: ReturnType<typeof execa>;

async function waitForEmulator(
  maxRetries = 10,
  retryDelay = 1000,
): Promise<boolean> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      await firestore.listCollections();
      console.log(`Firebase emulator ready after ${retries + 1} attempt(s)`);
      return true;
    } catch (error) {
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
  emulatorProcess = execa(
    "pnpm",
    ["firebase", "emulators:start", "--only", "firestore"],
    { stdio: "inherit", detached: true },
  );

  const emulatorReady = await waitForEmulator();
  if (!emulatorReady) {
    throw new Error("Firebase emulator failed to start");
  }

  console.log("Firebase emulator started successfully");
}

export async function teardown() {
  if (emulatorProcess?.pid) {
    await fkill(":8080");
  }
}

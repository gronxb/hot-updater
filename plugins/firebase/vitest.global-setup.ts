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
  ignoreUndefinedProperties: true,
});

let emulatorProcess: ReturnType<typeof execa>;

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

  // 기존 에뮬레이터 프로세스가 있는지 확인하고 종료
  try {
    await fkill(":8080");
    console.log("Killed existing emulator process");
  } catch (error) {
    console.log("No existing emulator process found");
  }

  // 에뮬레이터 시작 전에 환경 변수 설정
  process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  process.env.GCLOUD_PROJECT = "hot-updater-test";

  emulatorProcess = execa(
    "pnpm",
    ["firebase", "emulators:start", "--only", "firestore"],
    {
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: "localhost:8080",
        FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
        GCLOUD_PROJECT: "hot-updater-test",
      },
    },
  );

  const emulatorReady = await waitForEmulator();
  if (!emulatorReady) {
    throw new Error("Firebase emulator failed to start");
  }

  console.log("Firebase emulator started successfully");
}

export async function teardown() {
  if (emulatorProcess?.pid) {
    try {
      await fkill(":8080");
      console.log("Successfully killed emulator process");
    } catch (error) {
      console.error("Failed to kill emulator process:", error);
    }
  }
}

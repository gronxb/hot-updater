import type { Terminal } from "@xterm/xterm";
import { ClackRenderer, cyan, gray, green } from "./clack-renderer";
import type { DemoConfig } from "./types";

const DEMO_CONFIG: DemoConfig = {
  platform: "ios",
  channel: "production",
  fingerprint: "a1b2c3d4e5f6",
  plugins: {
    build: "bare",
    storage: "s3Storage",
    database: "standaloneRepository",
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDeployDemo(terminal: Terminal): Promise<void> {
  const clack = new ClackRenderer(terminal);

  terminal.clear();

  // Command
  await clack.typeText(
    `$ npx hot-updater deploy -i -p ${DEMO_CONFIG.platform}`,
    "\x1b[38;5;208m",
  );
  terminal.write("\r\n\r\n");
  await sleep(400);

  // Intro banner
  await clack.intro("Hot Updater - React Native OTA Solution");

  // Log steps
  await clack.log.step(`Channel: ${cyan(DEMO_CONFIG.channel)}`);
  await sleep(500);
  await clack.log.step(
    `Fingerprint(${DEMO_CONFIG.platform}): ${gray(DEMO_CONFIG.fingerprint)}`,
  );
  await sleep(200);

  // Building Bundle
  await clack.spinner(
    `📦  Building Bundle (${DEMO_CONFIG.plugins.build})`,
    700,
  );
  await clack.log.message(`✅  Build Complete (${DEMO_CONFIG.plugins.build})`);
  await sleep(200);

  // Uploading to Storage
  await clack.spinner(
    `📦  Uploading to Storage (${DEMO_CONFIG.plugins.storage})`,
    700,
  );
  await clack.log.message(
    `✅  Upload Complete (${DEMO_CONFIG.plugins.storage})`,
  );
  await sleep(500);

  // Updating Database
  await clack.spinner(
    `📦  Updating Database (${DEMO_CONFIG.plugins.database})`,
    700,
  );
  await clack.log.message(
    `✅  Update Complete (${DEMO_CONFIG.plugins.database})`,
  );
  await sleep(600);

  // Success outro
  await clack.outro(green("🚀  Deployment Successful"));
}

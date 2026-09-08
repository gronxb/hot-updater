import type { Terminal } from "@xterm/xterm";

import {
  blue,
  ClackRenderer,
  cyan,
  gray,
  green,
  magenta,
  yellow,
} from "./clack-renderer";
import type { DemoConfig } from "./types";

const DEMO_CONFIG: DemoConfig = {
  platform: "ios",
  channel: "production",
  appVersion: "1.0.0",
  plugins: {
    build: "bare",
    storage: "r2Storage",
    database: "d1Database",
  },
};

const DEMO_UPDATE_ID = "01a0586e-a286-7a74-a959-6d2c770b8793";

export async function runDeployDemo(
  terminal: Terminal,
  signal?: AbortSignal,
): Promise<void> {
  const clack = new ClackRenderer(terminal, signal);
  terminal.clear();

  await clack.typeText(
    `$ npx hot-updater deploy -p ${DEMO_CONFIG.platform}`,
    "\x1b[38;5;208m",
  );
  clack.write("\n\n");
  await clack.pause(200);
  clack.note("Deployment", [
    `Platform: ${cyan("iOS")}`,
    `Channel: ${blue(DEMO_CONFIG.channel)}`,
    `Rollout: ${green("100%")}`,
    `Target app version: ${magenta(DEMO_CONFIG.appVersion)}`,
  ]);

  await clack.task(
    `Building Bundle (${DEMO_CONFIG.plugins.build})`,
    `Build Complete (${DEMO_CONFIG.plugins.build})`,
    600,
  );
  await clack.task(
    `Uploading to Storage (${DEMO_CONFIG.plugins.storage})`,
    `Upload Complete (${DEMO_CONFIG.plugins.storage})`,
    700,
  );
  await clack.task(
    `Updating Database (${DEMO_CONFIG.plugins.database})`,
    `Update Complete (${DEMO_CONFIG.plugins.database})`,
    500,
  );

  const id = `${gray("  ID:")}\n${yellow(DEMO_UPDATE_ID)}`;
  clack.outro(`${green("Deployment successful")}\n${id}`);
  await clack.finish();
}

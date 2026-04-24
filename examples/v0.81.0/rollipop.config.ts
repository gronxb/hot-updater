import { mkdirSync, writeFileSync } from "fs";

import { config } from "dotenv";
import { defineConfig } from "rollipop";

config({ path: ".env.hotupdater" });

mkdirSync("./config", { recursive: true });
writeFileSync(
  "./config/.env",
  `
HOT_UPDATER_APP_BASE_URL=${process.env.HOT_UPDATER_APP_BASE_URL}
`,
);

export default defineConfig({
  envDir: "./config", // Load .env files from ./config directory
  envPrefix: "HOT_UPDATER_", // Only expose variables with MY_APP_ prefix
});

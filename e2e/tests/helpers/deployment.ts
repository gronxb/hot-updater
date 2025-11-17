import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SERVER_PORT = 3006;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const EXAMPLES_DIR = path.resolve(__dirname, "../../../examples");

export interface DeployOptions {
  appName: string;
  platform: "ios" | "android";
  force?: boolean;
}

/**
 * Deploy a bundle to the Hot Updater test server
 * This can be called from individual test cases
 */
export async function deployBundle(options: DeployOptions): Promise<void> {
  const { appName, platform, force = false } = options;
  const appPath = path.join(EXAMPLES_DIR, appName);

  if (!fs.existsSync(appPath)) {
    throw new Error(`App not found: ${appName}`);
  }

  const packageJsonPath = path.join(appPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found for app: ${appName}`);
  }

  console.log(`📦 Deploying bundle for ${appName}...`);

  try {
    // Check if .env.hotupdater exists
    const envPath = path.join(appPath, ".env.hotupdater");
    if (!fs.existsSync(envPath)) {
      console.log(`  ℹ️  Creating .env.hotupdater for ${appName}`);
      fs.writeFileSync(
        envPath,
        `# Hot Updater E2E Test Environment
PORT=${SERVER_PORT}
`,
      );
    }

    const deployCommand = force
      ? `npx hot-updater deploy --platform ${platform} --force`
      : `npx hot-updater deploy --platform ${platform}`;

    execSync(deployCommand, {
      cwd: appPath,
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
      },
    });

    console.log(`  ✅ Deployed ${appName}`);
  } catch (error) {
    console.error(`  ❌ Failed to deploy ${appName}:`, error);
    throw error;
  }
}

/**
 * Check if the Hot Updater server is running
 */
export async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(SERVER_URL);
    const data = (await response.json()) as { status: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Get server URL for tests
 */
export function getServerUrl(): string {
  return SERVER_URL;
}

/**
 * Get server port for tests
 */
export function getServerPort(): number {
  return SERVER_PORT;
}

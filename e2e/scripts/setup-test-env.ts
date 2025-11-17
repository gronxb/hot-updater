#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SERVER_DIR = path.resolve(__dirname, "../../examples-server/hono-drizzle-pglite");
const SERVER_PORT = 3006;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const PID_FILE = path.resolve(__dirname, "../.test-server.pid");

let serverProcess: any = null;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(SERVER_URL);
    const data = (await response.json()) as { status: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

async function waitForServer(maxAttempts = 30): Promise<void> {
  console.log(`⏳ Waiting for server at ${SERVER_URL}...`);

  for (let i = 0; i < maxAttempts; i++) {
    if (await checkServerHealth()) {
      console.log("✅ Server is ready!");
      return;
    }
    await sleep(1000);
  }

  throw new Error("Server failed to start within timeout");
}

async function startServer(): Promise<void> {
  console.log("\n🚀 Starting Hot Updater test server...");

  // Check if server directory exists
  if (!fs.existsSync(SERVER_DIR)) {
    throw new Error(`Server directory not found: ${SERVER_DIR}`);
  }

  // Check if node_modules exists
  const nodeModulesPath = path.join(SERVER_DIR, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log("📦 Installing server dependencies...");
    const { execSync } = await import("node:child_process");
    execSync("pnpm install", {
      cwd: SERVER_DIR,
      stdio: "inherit",
    });
  }

  // Initialize database schema
  console.log("🗄️  Initializing database...");
  const { execSync } = await import("node:child_process");

  // Clean up old database for fresh start
  const dataPath = path.join(SERVER_DIR, "data");
  if (fs.existsSync(dataPath)) {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }

  // Generate schema
  execSync("pnpm db:generate", {
    cwd: SERVER_DIR,
    stdio: "inherit",
  });

  // Start the server process
  serverProcess = spawn("pnpm", ["dev"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Save PID for cleanup
  fs.writeFileSync(PID_FILE, String(serverProcess.pid));

  // Handle server output
  serverProcess.stdout.on("data", (data: Buffer) => {
    const output = data.toString();
    if (process.env.VERBOSE) {
      console.log(`[Server] ${output.trim()}`);
    }
  });

  serverProcess.stderr.on("data", (data: Buffer) => {
    const output = data.toString();
    if (process.env.VERBOSE || output.includes("error")) {
      console.error(`[Server Error] ${output.trim()}`);
    }
  });

  serverProcess.on("error", (error: Error) => {
    console.error("❌ Failed to start server:", error);
    throw error;
  });

  serverProcess.on("exit", (code: number) => {
    if (code !== 0 && code !== null) {
      console.error(`❌ Server exited with code ${code}`);
    }
  });

  // Wait for server to be ready
  await waitForServer();
}


async function setup() {
  console.log("\n" + "=".repeat(60));
  console.log("🧪 Setting up E2E Test Environment");
  console.log("=".repeat(60));

  try {
    // Start server only
    await startServer();

    console.log("\n" + "=".repeat(60));
    console.log("✅ E2E Test Environment Ready!");
    console.log("ℹ️  Tests can deploy bundles using deployBundle() helper");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\n❌ Setup failed:", error);

    // Cleanup on failure
    if (serverProcess) {
      serverProcess.kill();
    }
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }

    process.exit(1);
  }
}

// Export for Jest globalSetup
export default setup;

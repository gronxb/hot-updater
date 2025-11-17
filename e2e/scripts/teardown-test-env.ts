#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";

const SERVER_PORT = 3006;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const PID_FILE = path.resolve(__dirname, "../.test-server.pid");

async function shutdownServer(): Promise<void> {
  console.log("\n🛑 Shutting down test server...");

  // Try graceful shutdown via API
  try {
    const response = await fetch(`${SERVER_URL}/shutdown`, {
      method: "POST",
    });

    if (response.ok) {
      console.log("✅ Server shut down gracefully");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.log("⚠️  Graceful shutdown failed, trying process kill...");
  }

  // Fallback: kill by PID
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());

      if (pid && !Number.isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          console.log(`✅ Killed server process (PID: ${pid})`);

          // Wait a bit for process to die
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Force kill if still running
          try {
            process.kill(pid, 0); // Check if process exists
            process.kill(pid, "SIGKILL");
            console.log("  Force killed process");
          } catch {
            // Process already dead
          }
        } catch (error: any) {
          if (error.code === "ESRCH") {
            console.log("  Process already terminated");
          } else {
            console.error("  Failed to kill process:", error);
          }
        }
      }

      fs.unlinkSync(PID_FILE);
    } catch (error) {
      console.error("❌ Error reading PID file:", error);
    }
  }
}

async function cleanup(): Promise<void> {
  console.log("\n🧹 Cleaning up test environment...");

  const filesToClean = [
    path.resolve(__dirname, "../.test-server.pid"),
    path.resolve(__dirname, "../../examples-server/hono-drizzle-pglite/data"),
  ];

  for (const file of filesToClean) {
    if (fs.existsSync(file)) {
      try {
        const stats = fs.statSync(file);
        if (stats.isDirectory()) {
          // Don't delete the data directory, just log it
          console.log(`  ℹ️  Keeping data directory: ${file}`);
        } else {
          fs.unlinkSync(file);
          console.log(`  🗑️  Removed: ${file}`);
        }
      } catch (error) {
        console.error(`  ⚠️  Failed to remove ${file}:`, error);
      }
    }
  }
}

async function teardown() {
  console.log("\n" + "=".repeat(60));
  console.log("🧹 Tearing down E2E Test Environment");
  console.log("=".repeat(60));

  try {
    await shutdownServer();
    await cleanup();

    console.log("\n" + "=".repeat(60));
    console.log("✅ Test Environment Cleaned Up!");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\n❌ Teardown failed:", error);
    process.exit(1);
  }
}

// Export for Jest globalTeardown
export default teardown;

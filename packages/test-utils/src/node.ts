import { execFileSync } from "node:child_process";

export function hasDockerDaemon(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export * from "./mockReactNativeProjectRoot";
export * from "./setupHandlerIntegrationTestSuite";

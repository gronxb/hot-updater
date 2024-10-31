import { spawn } from "node:child_process";

export const openConsole = () => {
  const consoleAppPath = import.meta
    .resolve("@hot-updater/console2")
    .replace("file://", "");

  const childProcess = spawn("node", [consoleAppPath], { stdio: "inherit" });
  process.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });

  process.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });

  const killChildProcess = () => {
    console.log("Killing child process...");
    childProcess.kill("SIGTERM");
  };

  process.on("SIGINT", killChildProcess);
  process.on("SIGTERM", killChildProcess);
  process.on("exit", killChildProcess);

  childProcess.on("close", (code) => {
    console.log(`Child process exited with code ${code}`);
  });
};

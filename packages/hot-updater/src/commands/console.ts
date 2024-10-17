import { spawn } from "node:child_process";
import { platform } from "node:os";
import path from "node:path";

export const openConsole = () => {
  const consoleAppPath = import.meta
    .resolve("@hot-updater/console")
    .replace("file://", "");

  if (platform() === "darwin") {
    const childProcess = spawn(
      path.join(consoleAppPath, "console.app/Contents/MacOS/HotUpdater"),
      { stdio: "inherit" },
    );
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
  } else {
    console.error("Not Supported");
  }
};

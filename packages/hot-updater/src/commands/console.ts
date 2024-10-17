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

    // 부모 프로세스가 종료될 때 자식 프로세스도 종료하도록 설정
    const killChildProcess = () => {
      console.log("Killing child process...");
      childProcess.kill("SIGTERM"); // SIGTERM 시그널로 자식 프로세스 종료
    };

    // Node.js 프로세스가 종료될 때 자식 프로세스를 종료하는 시그널 핸들러
    process.on("SIGINT", killChildProcess); // Ctrl+C 시그널 처리
    process.on("SIGTERM", killChildProcess); // Kill 시그널 처리
    process.on("exit", killChildProcess); // Process exit 처리

    childProcess.on("close", (code) => {
      console.log(`Child process exited with code ${code}`);
    });
  } else {
    console.error("Not Supported");
  }
  // const childProcess = spawn("open", ["-a", "Console"]);
};

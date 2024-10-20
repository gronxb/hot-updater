import { TauriEvent, listen } from "@tauri-apps/api/event";
import { error, info, trace } from "@tauri-apps/plugin-log";
import { type Child, Command } from "@tauri-apps/plugin-shell";

class ProcessManager {
  private childProcess: Child | null = null;

  async setCwd(newCwd: string) {
    trace(`Setting cwd to ${newCwd}`);

    if (this.childProcess) {
      trace(`Killing process ${this.childProcess.pid}`);
      await this.childProcess.kill();
      this.childProcess = null;
    }

    const cmd = Command.sidecar("binaries/app", [], { cwd: newCwd });

    cmd.stdout.on("data", (data) => {
      info(data);
    });

    cmd.stderr.on("data", (data) => {
      error(data);
    });

    this.childProcess = await cmd.spawn();

    listen(TauriEvent.WINDOW_DESTROYED, () => {
      if (this.childProcess) {
        this.childProcess.kill();
      }
    });
  }
}

export const processManager = new ProcessManager();

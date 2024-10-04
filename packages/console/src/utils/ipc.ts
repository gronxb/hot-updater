import { Command } from "@tauri-apps/plugin-shell";

export const invoke = async (command: string, args: string[] = []) => {
  const $command = Command.sidecar("binaries/app", [command, ...args]);
  const output = await $command.execute();
  const response = output.stdout;
  return JSON.parse(response);
};

import { cwd } from "@/cwd";
import { loadConfig } from "@/utils/loadConfig";
import type { PluginArgs } from "@hot-updater/internal";

export const deploy = async (
  options: Pick<PluginArgs, "targetVersion" | "platform">,
) => {
  const { build, deploy, ...config } = await loadConfig();

  const path = cwd();

  await build({ cwd: path, ...options, ...config });
  await deploy({ cwd: path, ...options, ...config }).upload();
};

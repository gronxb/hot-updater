import { cwd } from "@/cwd";
import { loadConfig } from "@/utils/loadConfig";

export const deploy = async (platform: "ios" | "android") => {
  const { build, deploy, ...config } = await loadConfig();

  const path = cwd();

  await build({ platform, cwd: path, ...config });
  await deploy({ platform, cwd: path, ...config }).upload();
};

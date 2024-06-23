import { cwd } from "@/cwd";
import { loadConfig } from "@/utils/loadConfig";

export const deploy = async (platform: "ios" | "android") => {
  const { build, deploy } = await loadConfig();

  const path = cwd();

  await build(platform, path);
  await deploy(path).upload();
};

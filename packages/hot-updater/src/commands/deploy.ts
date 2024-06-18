import { cwd } from "@/cwd";
import { loadConfig } from "@/utils/loadConfig";

export const deploy = async () => {
  const { build, deploy } = await loadConfig();

  const path = cwd();

  await build(path);
  await deploy(path);
};

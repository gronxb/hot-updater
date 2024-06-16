import { loadConfig } from "@/utils/loadConfig";
import { metro } from "../plugins/metro";

export const deploy = async () => {
  // metro();
  const { deploy } = await loadConfig();

  for (const plugin of deploy) {
    await plugin();
  }
};

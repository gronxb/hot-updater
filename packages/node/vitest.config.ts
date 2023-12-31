import { join } from "path";
import { cwd } from "process";
import { getWorkspaces } from "workspace-tools";

export default {
  resolve: {
    alias: {
      ...getWorkspaces(cwd()).reduce((acc, item) => {
        acc[item.name] = join(item.path, "src", "index.ts");
        return acc;
      }, {} as Record<string, string>),
    },
  },
};

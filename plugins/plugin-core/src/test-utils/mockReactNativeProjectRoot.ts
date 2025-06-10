import fs from "fs";
import { randomUUID } from "node:crypto";
import os from "os";
import path from "path";
import { getPnpmWorkspaces } from "workspace-tools";
import { getCwd } from "../cwd";

export interface MockedReactNativeProjectRoot {
  rootDir: string;
}
type Example = "rn-77";

const resolveWorkspaceInfoFromExample = (example: Example) => {
  const workspaces = getPnpmWorkspaces(getCwd()).filter((ws) =>
    ws.path.includes("hot-updater/examples"),
  );
  switch (example) {
    case "rn-77":
      return workspaces.find(
        (ws) => ws.name === "@hot-updater/example-react-native-v77",
      )!;
  }
};

export const mockReactNativeProjectRoot = async ({
  example,
}: { example: Example }): Promise<MockedReactNativeProjectRoot> => {
  const rootDir = path.resolve(os.tmpdir(), ".hot-updater", randomUUID());
  const workspace = resolveWorkspaceInfoFromExample(example);

  const copiedFiles = fs
    .readdirSync(workspace.path)
    .filter((p) => p !== "node_modules");

  if (fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  await fs.promises.mkdir(rootDir, { recursive: true });

  await fs.promises.cp(workspace.path, rootDir, {
    force: true,
    recursive: true,
    filter: (src, dest) => {
      const filename = path.basename(src);
      if (src.startsWith(path.resolve(workspace.path, "node_modules"))) {
        return false;
      }
      if (filename.endsWith(".env")) {
        return false;
      }
      return true;
    },
  });

  return {
    rootDir,
  };
};

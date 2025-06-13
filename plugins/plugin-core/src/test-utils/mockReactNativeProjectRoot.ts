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

const REQUIRED_FILES = ["package.json", "ios", "android", ".gitignore"];

export const mockReactNativeProjectRoot = async ({
  example,
}: { example: Example }): Promise<MockedReactNativeProjectRoot> => {
  const rootDir = path.resolve(os.tmpdir(), ".hot-updater", randomUUID());
  const workspace = resolveWorkspaceInfoFromExample(example);

  if (fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  await fs.promises.mkdir(rootDir, { recursive: true });

  // 필요한 파일만 복사
  for (const file of REQUIRED_FILES) {
    const sourcePath = path.join(workspace.path, file);
    const targetPath = path.join(rootDir, file);

    if (fs.existsSync(sourcePath)) {
      if (fs.statSync(sourcePath).isDirectory()) {
        await fs.promises.cp(sourcePath, targetPath, {
          force: true,
          recursive: true,
          filter: (src) => {
            const filename = path.basename(src);
            return !src.includes("node_modules") && !filename.endsWith(".env");
          },
        });
      } else {
        await fs.promises.copyFile(sourcePath, targetPath);
      }
    }
  }

  return {
    rootDir,
  };
};

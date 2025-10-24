import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { getPnpmWorkspaces } from "workspace-tools";
import { getCwd } from "../cwd";

export interface MockedReactNativeProjectRoot {
  rootDir: string;
}

type Example = "rn-77";

const resolveWorkspaceInfoFromExample = (example: Example) => {
  const workspaces = getPnpmWorkspaces(getCwd()).filter(
    (ws) => ws.path.includes("examples") || ws.name?.includes("example"),
  );
  switch (example) {
    case "rn-77": {
      const workspace = workspaces.find(
        (ws) => ws.name === "@hot-updater/example-react-native-v77",
      );
      if (!workspace) {
        throw new Error(
          `Could not find workspace @hot-updater/example-react-native-v77. Available workspaces: ${workspaces.map((ws) => ws.name).join(", ")}`,
        );
      }
      return workspace;
    }
  }
};

// 테스트에 필요한 최소한의 파일만 정의
const REQUIRED_FILES = [
  "package.json",
  "ios/Info.plist",
  "android/app/build.gradle",
  ".gitignore",
];

export const mockReactNativeProjectRoot = async ({
  example,
}: {
  example: Example;
}): Promise<MockedReactNativeProjectRoot> => {
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
      // 디렉토리 생성
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      // 파일 복사
      await fs.promises.copyFile(sourcePath, targetPath);
    }
  }

  return {
    rootDir,
  };
};

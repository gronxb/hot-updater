import { execa } from "execa";
import { expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../utils/parseXcodeProjectInfo", () => ({
  parseXcodeProjectInfo: async () => ({
    name: "App.xcworkspace",
    isWorkspace: true,
  }),
}));
vi.mock("../utils/createRandomTmpDir", () => ({
  createRandomTmpDir: async () => "/build",
}));
vi.mock("../utils/runXcodebuildWithLogging", () => ({
  runXcodebuildWithLogging: vi.fn(),
}));

import { buildXcodeProject } from "./buildXcodeProject";

const product = (target: string, extension: string) => ({
  target,
  buildSettings: {
    TARGET_BUILD_DIR: "/build",
    WRAPPER_EXTENSION: extension,
    EXECUTABLE_FOLDER_PATH: `${target}.${extension}`,
    FULL_PRODUCT_NAME: `${target}.${extension}`,
    INFOPLIST_PATH: `${target}.${extension}/Info.plist`,
  },
});

it.each(["SparklingGo", "React"])(
  "selects the %s application after dependency framework settings",
  async (name) => {
    vi.mocked(execa).mockResolvedValue({
      stdout: JSON.stringify([
        product("Lynx", "framework"),
        product(name, "app"),
      ]),
    } as Awaited<ReturnType<typeof execa>>);

    await expect(
      buildXcodeProject({
        sourceDir: "/app/ios",
        platform: "ios",
        xcodeScheme: name,
        configuration: "Release",
        deviceType: "simulator",
        logPrefix: "build",
        destination: [{ id: "simulator-id" }],
      }),
    ).resolves.toEqual({
      appPath: `/build/${name}.app`,
      infoPlistPath: `/build/${name}.app/Info.plist`,
    });
  },
);

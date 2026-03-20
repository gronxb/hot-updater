import { transformSync } from "@babel/core";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uuidv7Mock = vi.hoisted(() => vi.fn());
const createdDirectories: string[] = [];

vi.mock("uuidv7", () => ({
  uuidv7: uuidv7Mock,
}));

async function transformCode(
  code: string,
  buildOutDir?: string,
): Promise<string | null> {
  const previousBuildOutDir = process.env["BUILD_OUT_DIR"];

  if (buildOutDir !== undefined) {
    process.env["BUILD_OUT_DIR"] = buildOutDir;
  }

  try {
    const { default: babelPlugin } = await import("./babel");
    const result = transformSync(code, {
      plugins: [babelPlugin],
      configFile: false,
      babelrc: false,
    });

    return result?.code ?? null;
  } finally {
    if (buildOutDir !== undefined) {
      if (previousBuildOutDir !== undefined) {
        process.env["BUILD_OUT_DIR"] = previousBuildOutDir;
      } else {
        delete process.env["BUILD_OUT_DIR"];
      }
    }
  }
}

describe("Babel Plugin - Hot Updater", () => {
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env["BUILD_OUT_DIR"];
    uuidv7Mock.mockReturnValue("generated-bundle-id");
  });

  afterEach(async () => {
    delete process.env["BUILD_OUT_DIR"];
    consoleLogSpy.mockClear();
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  describe("BUNDLE_ID file generation", () => {
    it("does nothing when BUILD_OUT_DIR is not set", async () => {
      await transformCode(`const foo = "bar";`);

      expect(uuidv7Mock).not.toHaveBeenCalled();
    });

    it("creates BUNDLE_ID when BUILD_OUT_DIR is set and the file is missing", async () => {
      const buildOutDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-babel-"),
      );
      createdDirectories.push(buildOutDir);

      await transformCode(`const foo = "bar";`, buildOutDir);

      const bundleId = await fs.readFile(
        path.join(buildOutDir, "BUNDLE_ID"),
        "utf-8",
      );

      expect(uuidv7Mock).toHaveBeenCalledWith();
      expect(bundleId).toBe("generated-bundle-id");
    });

    it("does not overwrite an existing BUNDLE_ID file", async () => {
      const buildOutDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-babel-"),
      );
      createdDirectories.push(buildOutDir);

      await fs.writeFile(
        path.join(buildOutDir, "BUNDLE_ID"),
        "existing-bundle-id",
      );

      await transformCode(`const foo = "bar";`, buildOutDir);

      const bundleId = await fs.readFile(
        path.join(buildOutDir, "BUNDLE_ID"),
        "utf-8",
      );

      expect(uuidv7Mock).not.toHaveBeenCalled();
      expect(bundleId).toBe("existing-bundle-id");
    });
  });

  describe("Expo DOM Component transformation", () => {
    it("transforms WebView filePath string literals into overrideUri objects", async () => {
      const result = await transformCode(`
        React.createElement(WebView, {
          filePath: "index.html",
          style: { flex: 1 }
        });
      `);

      expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      expect(result).toContain('"www.bundle"');
      expect(result).toContain("overrideUri");
      expect(result).toContain('"index.html"');
    });

    it("transforms top-level filePath variables that point to html files", async () => {
      const result = await transformCode(`
        const filePath = "component.html";
        React.createElement(WebView, { filePath });
      `);

      expect(result).toContain('"component.html"');
      expect(result).toContain("overrideUri");
    });

    it("preserves spread dom props when generating overrideUri", async () => {
      const result = await transformCode(`
        const domProps = { backgroundColor: "white" };
        React.createElement(WebView, {
          ...domProps,
          filePath: "index.html"
        });
      `);

      expect(result).toContain("...domProps.dom");
      expect(result).toContain("overrideUri");
    });

    it("does not transform non-html file paths", async () => {
      const result = await transformCode(`
        React.createElement(WebView, { filePath: "index.js" });
      `);

      expect(result).not.toContain("overrideUri");
      expect(result).toContain('"index.js"');
    });

    it("does not transform non-WebView components", async () => {
      const result = await transformCode(`
        React.createElement(View, { filePath: "index.html" });
      `);

      expect(result).not.toContain("overrideUri");
      expect(result).toContain('"index.html"');
    });
  });
});

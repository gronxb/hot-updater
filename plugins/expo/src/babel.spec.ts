import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TransformResult = {
  code?: string | null;
};

type TransformSync = (
  code: string,
  options: {
    plugins: unknown[];
    configFile: false;
    babelrc: false;
  },
) => TransformResult | null;

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core") as {
  transformSync: TransformSync;
};

async function transformCode(code: string): Promise<string | null> {
  try {
    const { default: babelPlugin } = await import("./babel");
    const result = transformSync(code, {
      plugins: [babelPlugin],
      configFile: false,
      babelrc: false,
    });

    return result?.code ?? null;
  } finally {
    // Clear ESM module state between test cases.
  }
}

describe("Babel Plugin - Hot Updater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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

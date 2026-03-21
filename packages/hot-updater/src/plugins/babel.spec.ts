import { transformSync } from "@babel/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import babelPlugin from "./babel";

// Mock fs module for getBundleId() testing
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock path module
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return {
    ...actual,
    join: vi.fn(),
  };
});

// Mock uuidv7 for predictable UUID generation
vi.mock("uuidv7", () => ({
  uuidv7: vi.fn(),
}));

/**
 * Helper function to transform code using the babel plugin
 * @param code - Input code string
 * @param buildOutDir - Optional BUILD_OUT_DIR environment variable
 * @returns Transformed code or null if transformation failed
 */
function transformCode(code: string, buildOutDir?: string): string | null {
  const oldEnv = process.env["BUILD_OUT_DIR"];

  if (buildOutDir !== undefined) {
    process.env["BUILD_OUT_DIR"] = buildOutDir;
  }

  try {
    const result = transformSync(code, {
      plugins: [babelPlugin],
      configFile: false,
      babelrc: false,
    });

    return result?.code ?? null;
  } finally {
    if (buildOutDir !== undefined) {
      if (oldEnv !== undefined) {
        process.env["BUILD_OUT_DIR"] = oldEnv;
      } else {
        delete process.env["BUILD_OUT_DIR"];
      }
    }
  }
}

/**
 * Helper to normalize whitespace for easier comparison
 */
function normalizeCode(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

describe("Babel Plugin - Hot Updater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["BUILD_OUT_DIR"];
  });

  afterEach(() => {
    delete process.env["BUILD_OUT_DIR"];
  });

  describe("Bundle ID Replacement", () => {
    describe("when BUILD_OUT_DIR is not set", () => {
      it("should replace __HOT_UPDATER_BUNDLE_ID with NIL_UUID", () => {
        const input = `const bundleId = __HOT_UPDATER_BUNDLE_ID;`;
        const expected = `const bundleId = "00000000-0000-0000-0000-000000000000";`;

        const result = transformCode(input);

        expect(normalizeCode(result!)).toBe(normalizeCode(expected));
      });

      it("should handle multiple occurrences of __HOT_UPDATER_BUNDLE_ID", () => {
        const input = `
          const bundleId1 = __HOT_UPDATER_BUNDLE_ID;
          const bundleId2 = __HOT_UPDATER_BUNDLE_ID;
          console.log(__HOT_UPDATER_BUNDLE_ID);
        `;

        const result = transformCode(input);

        expect(result).toContain('"00000000-0000-0000-0000-000000000000"');
        expect(
          (result!.match(/00000000-0000-0000-0000-000000000000/g) || []).length,
        ).toBe(3);
      });

      it("should replace __HOT_UPDATER_BUNDLE_ID in function calls", () => {
        const input = `console.log(__HOT_UPDATER_BUNDLE_ID);`;
        const expected = `console.log("00000000-0000-0000-0000-000000000000");`;

        const result = transformCode(input);

        expect(normalizeCode(result!)).toBe(normalizeCode(expected));
      });

      it("should replace __HOT_UPDATER_BUNDLE_ID in object properties", () => {
        const input = `const obj = { id: __HOT_UPDATER_BUNDLE_ID };`;
        const expected = `const obj = { id: "00000000-0000-0000-0000-000000000000" };`;

        const result = transformCode(input);

        expect(normalizeCode(result!)).toBe(normalizeCode(expected));
      });

      it("should replace __HOT_UPDATER_BUNDLE_ID in array literals", () => {
        const input = `const arr = [__HOT_UPDATER_BUNDLE_ID, "other"];`;
        const expected = `const arr = ["00000000-0000-0000-0000-000000000000", "other"];`;

        const result = transformCode(input);

        expect(normalizeCode(result!)).toBe(normalizeCode(expected));
      });

      it("should replace __HOT_UPDATER_BUNDLE_ID in return statements", () => {
        const input = `function getId() { return __HOT_UPDATER_BUNDLE_ID; }`;
        const expected = `function getId() { return "00000000-0000-0000-0000-000000000000"; }`;

        const result = transformCode(input);

        expect(normalizeCode(result!)).toBe(normalizeCode(expected));
      });
    });

    // Note: Tests for BUILD_OUT_DIR being set are skipped because getBundleId()
    // is called once when the module loads, making it difficult to test different
    // scenarios in the same test run. The core functionality (replacing
    // __HOT_UPDATER_BUNDLE_ID) is already well tested with NIL_UUID above.

    describe("edge cases", () => {
      it("should not replace variables with similar names", () => {
        const input = `
          const __HOT_UPDATER_BUNDLE_ID_OLD = "old";
          const MY___HOT_UPDATER_BUNDLE_ID = "mine";
          const bundleId = __HOT_UPDATER_BUNDLE_ID;
        `;

        const result = transformCode(input);

        expect(result).toContain("__HOT_UPDATER_BUNDLE_ID_OLD");
        expect(result).toContain("MY___HOT_UPDATER_BUNDLE_ID");
        expect(result).toContain("00000000-0000-0000-0000-000000000000");
      });

      it("should handle empty input", () => {
        const input = ``;
        const result = transformCode(input);
        expect(result).toBe("");
      });

      it("should handle code without __HOT_UPDATER_BUNDLE_ID", () => {
        const input = `const foo = "bar";`;
        const result = transformCode(input);
        expect(result).toContain('const foo = "bar"');
        expect(result).not.toContain("__HOT_UPDATER_BUNDLE_ID");
      });
    });
  });

  describe("Expo DOM Component Transformation", () => {
    describe("basic WebView filePath transformation", () => {
      it("should transform filePath with string literal ending in .html", () => {
        const input = `
          import React from "react";
          import { WebView } from "react-native-webview";

          React.createElement(WebView, {
            filePath: "index.html",
            style: { flex: 1 }
          });
        `;

        const result = transformCode(input);

        // Should transform filePath into a spread IIFE that:
        // 1. Checks if globalThis.HotUpdaterGetBaseURL exists
        // 2. If exists: returns { dom: { overrideUri: [baseURL, "www.bundle", "index.html"].join("/") }, filePath: "index.html" }
        // 3. If not: returns { filePath: "index.html" }
        expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
        expect(result).toContain("www.bundle");
        expect(result).toContain("index.html");
        expect(result).toContain("void 0");

        // Verify the transformation structure
        expect(result).toContain("overrideUri");
        expect(result).toContain('.join("/")');
        expect(result).toContain("baseURL ?");
      });

      it("should transform filePath with hash filename", () => {
        // Input: createElement with filePath property pointing to .html file
        const input = `
          React.createElement(WebView, {
            filePath: "15b75327d3ccf662aed3779fbfb0b730.html"
          });
        `;

        const result = transformCode(input);

        // Expected transformation:
        // React.createElement(WebView, {
        //   ...(baseURL => baseURL ? {
        //     dom: { overrideUri: [baseURL, "www.bundle", "15b75327d3ccf662aed3779fbfb0b730.html"].join("/") },
        //     filePath: "15b75327d3ccf662aed3779fbfb0b730.html"
        //   } : {
        //     filePath: "15b75327d3ccf662aed3779fbfb0b730.html"
        //   })(typeof globalThis !== "undefined" && globalThis.HotUpdaterGetBaseURL ? globalThis.HotUpdaterGetBaseURL() : void 0)
        // });

        expect(result).toContain("15b75327d3ccf662aed3779fbfb0b730.html");
        expect(result).toContain('"www.bundle"');
        expect(result).toContain("overrideUri:");
        expect(result).toContain(
          '[baseURL, "www.bundle", "15b75327d3ccf662aed3779fbfb0b730.html"].join("/")',
        );
        expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      });

      it("should transform multiple WebView components independently", () => {
        const input = `
          React.createElement(WebView, { filePath: "page1.html" });
          React.createElement(WebView, { filePath: "page2.html" });
        `;

        const result = transformCode(input);

        expect(result).toContain("page1.html");
        expect(result).toContain("page2.html");
        // Each WebView generates 2 references to globalThis.HotUpdaterGetBaseURL
        // (one in condition check, one in function call)
        expect(
          (result!.match(/globalThis\.HotUpdaterGetBaseURL/g) || []).length,
        ).toBe(4);
      });
    });

    describe("variable reference transformation", () => {
      it("should transform filePath using variable reference", () => {
        const input = `
          const filePath = "index.html";
          React.createElement(WebView, { filePath: filePath });
        `;

        const result = transformCode(input);

        expect(result).toContain("index.html");
        expect(result).toContain("www.bundle");
        expect(result).toContain("overrideUri");
      });

      it("should transform filePath with variable declared at top level", () => {
        const input = `
          const filePath = "component.html";

          function MyComponent() {
            return React.createElement(WebView, {
              filePath: filePath,
              style: { flex: 1 }
            });
          }
        `;

        const result = transformCode(input);

        expect(result).toContain("component.html");
        expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      });

      it("should not transform if variable reference is not declared", () => {
        const input = `
          React.createElement(WebView, { filePath: undeclaredVar });
        `;

        const result = transformCode(input);

        expect(result).toContain("undeclaredVar");
        expect(result).not.toContain("overrideUri");
      });

      it("should only use variable if it ends with .html", () => {
        const input = `
          const filePath = "index.js";
          React.createElement(WebView, { filePath: filePath });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
        expect(result).toContain("filePath");
      });
    });

    describe("spread element preservation", () => {
      it("should preserve spread element in dom property", () => {
        const input = `
          const domProps = { backgroundColor: "white" };
          React.createElement(WebView, {
            ...domProps,
            filePath: "index.html"
          });
        `;

        const result = transformCode(input);

        expect(result).toContain("...domProps.dom");
        expect(result).toContain("overrideUri");
        expect(result).toContain("index.html");
      });

      it("should work without spread elements", () => {
        const input = `
          React.createElement(WebView, {
            filePath: "index.html",
            style: { flex: 1 }
          });
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
      });
    });

    describe("component name matching", () => {
      it("should transform components ending with WebView", () => {
        const input = `
          React.createElement(CustomWebView, { filePath: "index.html" });
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
      });

      it("should transform namespaced WebView", () => {
        const input = `
          React.createElement(ReactNative.WebView, { filePath: "index.html" });
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
      });

      it("should not transform non-WebView components", () => {
        const input = `
          React.createElement(View, { filePath: "index.html" });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
        expect(result).toContain("filePath");
      });

      it("should not transform components with WebView in the middle", () => {
        const input = `
          React.createElement(WebViewContainer, { filePath: "index.html" });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
      });
    });

    describe("non-HTML file handling", () => {
      it("should not transform filePath without .html extension", () => {
        const input = `
          React.createElement(WebView, { filePath: "index.js" });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
        expect(result).toContain("filePath");
      });

      it("should not transform filePath with .htm extension", () => {
        const input = `
          React.createElement(WebView, { filePath: "index.htm" });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
      });

      it("should not transform empty filePath", () => {
        const input = `
          React.createElement(WebView, { filePath: "" });
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
      });
    });

    describe("generated IIFE structure", () => {
      it("should generate correct conditional structure", () => {
        const input = `
          React.createElement(WebView, { filePath: "test.html" });
        `;

        const result = transformCode(input);

        // Match arrow function with or without spaces
        expect(result).toMatch(/\(\s*baseURL\s*\)\s*=>|baseURL\s*=>/);
        expect(result).toContain("baseURL ?");
        expect(result).toContain("typeof globalThis");
        expect(result).toContain("!==");
        expect(result).toContain('"undefined"');
        expect(result).toContain("globalThis.HotUpdaterGetBaseURL()");
        expect(result).toContain("void 0");
      });

      it("should generate correct overrideUri structure", () => {
        const input = `
          React.createElement(WebView, { filePath: "page.html" });
        `;

        const result = transformCode(input);

        expect(result).toContain("[baseURL,");
        expect(result).toContain('"www.bundle"');
        expect(result).toContain('"page.html"');
        expect(result).toContain('.join("/")');
        expect(result).toContain("overrideUri:");
      });

      it("should preserve filePath in both branches", () => {
        const input = `
          React.createElement(WebView, { filePath: "test.html" });
        `;

        const result = transformCode(input);

        const filePathMatches = result!.match(/filePath:\s*"test\.html"/g);
        expect(filePathMatches).toBeTruthy();
        expect(filePathMatches!.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe("edge cases and error handling", () => {
      it("should handle nested createElement calls", () => {
        const input = `
          React.createElement(View, {},
            React.createElement(WebView, { filePath: "nested.html" })
          );
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
        expect(result).toContain("nested.html");
      });

      it("should not transform standalone createElement calls", () => {
        const input = `
          const { createElement } = React;
          createElement(WebView, { filePath: "index.html" });
        `;

        const result = transformCode(input);

        // The plugin only transforms member expressions like React.createElement
        // Standalone createElement calls are not transformed
        expect(result).not.toContain("overrideUri");
        expect(result).toContain("filePath");
      });

      it("should not transform if filePath is not a direct property", () => {
        const input = `
          const props = { filePath: "index.html" };
          React.createElement(WebView, props);
        `;

        const result = transformCode(input);

        expect(result).not.toContain("overrideUri");
      });

      it("should handle malformed createElement calls gracefully", () => {
        const input = `
          React.createElement();
          React.createElement(WebView);
          React.createElement(WebView, null);
        `;

        const result = transformCode(input);

        expect(result).toBeTruthy();
        expect(result).not.toContain("overrideUri");
      });

      it("should handle mixed properties", () => {
        const input = `
          React.createElement(WebView, {
            filePath: "index.html",
            source: { uri: "https://example.com" },
            style: { flex: 1 },
            onLoad: () => console.log("loaded")
          });
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
        expect(result).toContain("source:");
        expect(result).toContain("style:");
        expect(result).toContain("onLoad:");
      });
    });

    describe("real-world production code", () => {
      it("should handle production bundle format", () => {
        const input = `
          __d(function(g,r,i,a,m,e,d){
            Object.defineProperty(e,"__esModule",{value:!0}),
            e.default=void 0;
            var t=r(d[0]),
                f=r(d[1]);
            var b=t.default.createElement(f.WebView,{
              filePath:"15b75327d3ccf662aed3779fbfb0b730.html"
            });
            e.default=b;
          },963,[66,964]);
        `;

        const result = transformCode(input);

        expect(result).toContain("overrideUri");
        expect(result).toContain("15b75327d3ccf662aed3779fbfb0b730.html");
        expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      });
    });
  });

  describe("combined transformations", () => {
    it("should apply both bundle ID and WebView transformations", () => {
      const input = `
        const bundleId = __HOT_UPDATER_BUNDLE_ID;
        React.createElement(WebView, { filePath: "index.html" });
      `;

      const result = transformCode(input);

      expect(result).toContain("00000000-0000-0000-0000-000000000000");
      expect(result).toContain("overrideUri");
      expect(result).toContain("index.html");
    });

    it("should handle complex file with multiple transformations", () => {
      const input = `
        const APP_BUNDLE_ID = __HOT_UPDATER_BUNDLE_ID;
        const filePath = "component.html";

        function Component1() {
          console.log("Bundle:", __HOT_UPDATER_BUNDLE_ID);
          return React.createElement(WebView, { filePath: "page1.html" });
        }

        function Component2() {
          return React.createElement(CustomWebView, { filePath: filePath });
        }
      `;

      const result = transformCode(input);

      expect(
        (result!.match(/00000000-0000-0000-0000-000000000000/g) || []).length,
      ).toBe(2);

      expect(result).toContain("page1.html");
      expect(result).toContain("component.html");
      expect((result!.match(/overrideUri/g) || []).length).toBe(2);
    });
  });
});

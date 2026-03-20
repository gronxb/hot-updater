import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import babelPlugin from "./babel";

/**
 * Helper function to transform code using the babel plugin
 * @returns Transformed code or null if transformation failed
 */
function transformCode(code: string): string | null {
  const result = transformSync(code, {
    plugins: [babelPlugin],
    configFile: false,
    babelrc: false,
  });

  return result?.code ?? null;
}

/**
 * Helper to normalize whitespace for easier comparison
 */
function normalizeCode(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

describe("Babel Plugin - Hot Updater", () => {
  describe("Bundle ID Placeholder Handling", () => {
    it("leaves __HOT_UPDATER_BUNDLE_ID untouched", () => {
      const input = `const bundleId = __HOT_UPDATER_BUNDLE_ID;`;

      const result = transformCode(input);

      expect(normalizeCode(result!)).toBe(normalizeCode(input));
    });

    it("does not replace variables with similar names", () => {
      const input = `
        const __HOT_UPDATER_BUNDLE_ID_OLD = "old";
        const MY___HOT_UPDATER_BUNDLE_ID = "mine";
        const bundleId = __HOT_UPDATER_BUNDLE_ID;
      `;

      const result = transformCode(input);

      expect(result).toContain("__HOT_UPDATER_BUNDLE_ID_OLD");
      expect(result).toContain("MY___HOT_UPDATER_BUNDLE_ID");
      expect(result).toContain("__HOT_UPDATER_BUNDLE_ID");
      expect(result).not.toContain("00000000-0000-0000-0000-000000000000");
    });

    it("handles empty input", () => {
      const input = ``;
      const result = transformCode(input);
      expect(result).toBe("");
    });

    it("handles code without __HOT_UPDATER_BUNDLE_ID", () => {
      const input = `const foo = "bar";`;
      const result = transformCode(input);
      expect(result).toContain('const foo = "bar"');
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
    it("should apply WebView transformations without replacing bundle ID placeholders", () => {
      const input = `
        const bundleId = __HOT_UPDATER_BUNDLE_ID;
        React.createElement(WebView, { filePath: "index.html" });
      `;

      const result = transformCode(input);

      expect(result).toContain("__HOT_UPDATER_BUNDLE_ID");
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

      expect((result!.match(/__HOT_UPDATER_BUNDLE_ID/g) || []).length).toBe(2);

      expect(result).toContain("page1.html");
      expect(result).toContain("component.html");
      expect((result!.match(/overrideUri/g) || []).length).toBe(2);
    });
  });
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldTransformFile, transformBundle } from "./bundle-transformer";

describe("bundle-transformer", () => {
  const testDir = path.join(__dirname, "__test-bundle-transformer__");

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("shouldTransformFile", () => {
    it("should return true for .bundle files", () => {
      expect(shouldTransformFile("index.ios.bundle")).toBe(true);
      expect(shouldTransformFile("index.android.bundle")).toBe(true);
    });

    it("should return false for .hbc files", () => {
      expect(shouldTransformFile("index.ios.hbc")).toBe(false);
      expect(shouldTransformFile("index.android.hbc")).toBe(false);
    });

    it("should return false for other files", () => {
      expect(shouldTransformFile("index.js")).toBe(false);
      expect(shouldTransformFile("bundle.json")).toBe(false);
      expect(shouldTransformFile("test.html")).toBe(false);
    });
  });

  describe("transformBundle", () => {
    it("should transform filePath to dom.overrideUri with spread", async () => {
      const testBundle = path.join(testDir, "test.bundle");
      // Real Metro output with spread operator
      const content =
        '__d((function(g,r,i,a,m,e,d){var t=r(d[0]);e.default=t.default.createElement(WebView,{ref:u,...f,filePath:"test.html"})}),1,[2]);';

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);
      expect(result.occurrences).toBe(1);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("dom:{...f.dom,overrideUri:");
      expect(transformed).toContain('"www.bundle"');
      expect(transformed).toContain('"test.html"');
      expect(transformed).toContain(".join");
      expect(transformed).not.toContain("filePath:");
      // Check ES5 compatibility
      expect(transformed).toContain("typeof globalThis");
      expect(transformed).toContain("HotUpdaterGetBaseURL");
    });

    it("should transform filePath without spread", async () => {
      const testBundle = path.join(testDir, "no-spread.bundle");
      const content =
        '__d((function(){e.default=React.createElement(WebView,{filePath:"test.html"})}),1,[]);';

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);
      expect(result.occurrences).toBe(1);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("dom:{overrideUri:");
      expect(transformed).not.toContain("...f.dom");
      expect(transformed).not.toContain("filePath:");
    });

    it("should handle multiple occurrences", async () => {
      const testBundle = path.join(testDir, "multi.bundle");
      const content =
        "__d((function(){" +
        'React.createElement(WebView,{...a,filePath:"first.html"});' +
        'React.createElement(WebView,{...b,filePath:"second.html"});' +
        'React.createElement(WebView,{...c,filePath:"third.html"});' +
        "}),1,[]);";

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);
      expect(result.occurrences).toBe(3);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("...a.dom");
      expect(transformed).toContain("...b.dom");
      expect(transformed).toContain("...c.dom");
      expect(transformed).toContain('"first.html"');
      expect(transformed).toContain('"second.html"');
      expect(transformed).toContain('"third.html"');
    });

    it("should not transform non-html files", async () => {
      const testBundle = path.join(testDir, "no-html.bundle");
      const content =
        '__d((function(){React.createElement(WebView,{filePath:"image.png"})}),1,[]);';

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(false);
      expect(result.occurrences).toBe(0);

      const unchanged = await fs.readFile(testBundle, "utf-8");
      expect(unchanged).toContain('filePath:"image.png"');
    });

    it("should handle bundle with no filePath properties", async () => {
      const testBundle = path.join(testDir, "no-filepath.bundle");
      const content =
        "__d((function(){React.createElement(View,{style:{flex:1}})}),1,[]);";

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(false);
      expect(result.occurrences).toBe(0);
    });

    it("should handle non-existent files gracefully", async () => {
      const result = await transformBundle(
        path.join(testDir, "missing.bundle"),
      );

      expect(result.transformed).toBe(false);
      expect(result.occurrences).toBe(0);
    });

    it("should produce ES5-compatible output", async () => {
      const testBundle = path.join(testDir, "es5.bundle");
      const content =
        '__d((function(){React.createElement(WebView,{filePath:"test.html"})}),1,[]);';

      await fs.writeFile(testBundle, content, "utf-8");

      await transformBundle(testBundle);

      const transformed = await fs.readFile(testBundle, "utf-8");

      // Check for ES5 patterns
      expect(transformed).toContain("typeof globalThis");
      expect(transformed).toContain("?"); // ternary operator
      expect(transformed).toContain(":void 0");
      expect(transformed).not.toContain("?."); // no optional chaining
    });

    it("should handle real Metro minified output", async () => {
      const testBundle = path.join(testDir, "real-metro.bundle");
      // Real Metro output from Expo's use-dom directive
      const content =
        '__d((function(g,r,i,a,m,e,d){var f=r(d[0]);Object.defineProperty(e,"__esModule",{value:!0}),e.default=void 0;var t=f(r(d[1])),l=r(d[2]);e.default=t.default.forwardRef(((f,u)=>t.default.createElement(l.WebView,{ref:u,...f,filePath:"c571f45cff5761f160084fdab0301e79.html"})))}),1031,[1,132,1032]);';

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);
      expect(result.occurrences).toBe(1);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("dom:{...f.dom,overrideUri:");
      expect(transformed).toContain('"c571f45cff5761f160084fdab0301e79.html"');
      expect(transformed).not.toContain("filePath:");
    });

    it("should preserve other properties when transforming", async () => {
      const testBundle = path.join(testDir, "preserve.bundle");
      const content =
        '__d((function(){React.createElement(WebView,{style:{flex:1},ref:myRef,...props,filePath:"test.html",testID:"webview"})}),1,[]);';

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("style:");
      expect(transformed).toContain("ref:");
      expect(transformed).toContain("testID:");
      expect(transformed).toContain("dom:");
      expect(transformed).not.toContain("filePath:");
    });

    it("should handle different spread variable names", async () => {
      const testBundle = path.join(testDir, "diff-vars.bundle");
      const content =
        "__d((function(){" +
        'React.createElement(WebView,{...props,filePath:"a.html"});' +
        'React.createElement(WebView,{...otherProps,filePath:"b.html"});' +
        'React.createElement(WebView,{...x,filePath:"c.html"});' +
        "}),1,[]);";

      await fs.writeFile(testBundle, content, "utf-8");

      const result = await transformBundle(testBundle);

      expect(result.transformed).toBe(true);
      expect(result.occurrences).toBe(3);

      const transformed = await fs.readFile(testBundle, "utf-8");
      expect(transformed).toContain("...props.dom");
      expect(transformed).toContain("...otherProps.dom");
      expect(transformed).toContain("...x.dom");
    });
  });
});

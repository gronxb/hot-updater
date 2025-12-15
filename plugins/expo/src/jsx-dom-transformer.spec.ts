import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { transformDOMComponents } from "./jsx-dom-transformer";

describe("jsx-dom-transformer", () => {
  describe("transformDOMComponents", () => {
    it("should transform WebView component with filePath prop", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-webview.tsx");
      const code = `import React from 'react';
import { View } from 'react-native';

export function App() {
  return (
    <View>
      <WebView filePath="abc123.html" />
    </View>
  );
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      const result = await transformDOMComponents(testFile);

      // Assert
      expect(result).toBe(true);

      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toContain(
        'import { HotUpdater } from "@hot-updater/react-native";',
      );
      expect(transformed).toContain(
        'overrideUri={[HotUpdater.getBaseURL(), "www.bundle", "abc123.html"].join("/")}',
      );
      expect(transformed).not.toContain("filePath=");

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should transform dom.WebView component with filePath prop", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-dom-webview.tsx");
      const code = `import React from 'react';
import { View } from 'react-native';
import * as dom from 'expo-dom';

export function App() {
  return (
    <View>
      <dom.WebView filePath="xyz789.html" />
    </View>
  );
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      const result = await transformDOMComponents(testFile);

      // Assert
      expect(result).toBe(true);

      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toContain(
        'import { HotUpdater } from "@hot-updater/react-native";',
      );
      expect(transformed).toContain(
        'overrideUri={[HotUpdater.getBaseURL(), "www.bundle", "xyz789.html"].join("/")}',
      );

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should not transform components without filePath prop", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-no-filepath.tsx");
      const code = `import React from 'react';
import { View } from 'react-native';

export function App() {
  return (
    <View>
      <WebView source={{ uri: "https://example.com" }} />
    </View>
  );
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      const result = await transformDOMComponents(testFile);

      // Assert
      expect(result).toBe(false);

      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toBe(code);

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should add HotUpdater import when not present", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-add-import.tsx");
      const code = `import React from 'react';

export function App() {
  return <WebView filePath="test.html" />;
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      await transformDOMComponents(testFile);

      // Assert
      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toContain(
        'import { HotUpdater } from "@hot-updater/react-native";',
      );

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should not duplicate HotUpdater import when already present", async () => {
      // Arrange
      const testFile = path.join(
        __dirname,
        "__test__/test-existing-import.tsx",
      );
      const code = `import React from 'react';
import { HotUpdater } from '@hot-updater/react-native';

export function App() {
  return <WebView filePath="test.html" />;
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      await transformDOMComponents(testFile);

      // Assert
      const transformed = await fs.readFile(testFile, "utf-8");
      const importCount = (
        transformed.match(
          /import.*HotUpdater.*from.*@hot-updater\/react-native/g,
        ) || []
      ).length;
      expect(importCount).toBe(1);

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should handle multiple WebView components in the same file", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-multiple.tsx");
      const code = `import React from 'react';

export function App() {
  return (
    <>
      <WebView filePath="first.html" />
      <WebView filePath="second.html" />
    </>
  );
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      const result = await transformDOMComponents(testFile);

      // Assert
      expect(result).toBe(true);

      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toContain(
        'overrideUri={[HotUpdater.getBaseURL(), "www.bundle", "first.html"].join("/")}',
      );
      expect(transformed).toContain(
        'overrideUri={[HotUpdater.getBaseURL(), "www.bundle", "second.html"].join("/")}',
      );

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should preserve other props when transforming", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-preserve-props.tsx");
      const code = `import React from 'react';

export function App() {
  return <WebView filePath="test.html" style={{ flex: 1 }} testID="webview" />;
}`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      await transformDOMComponents(testFile);

      // Assert
      const transformed = await fs.readFile(testFile, "utf-8");
      expect(transformed).toContain("style");
      expect(transformed).toContain("testID");
      expect(transformed).toContain("overrideUri");

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });

    it("should not transform bundled React.createElement code (post-build limitation)", async () => {
      // Arrange
      const testFile = path.join(__dirname, "__test__/test-bundled.js");
      // Simulating Metro bundler output with React.createElement
      const code = `__d(function(g,r,i,a,m,_e,d){"use strict";
Object.defineProperty(_e,'__esModule',{value:!0});
var e,t=r(d[0]),f=(e=t)&&e.__esModule?e:{default:e},u=r(d[1]),
l=f.default.forwardRef((e,t)=>f.default.createElement(u.WebView,{ref:t,...e,filePath:"15b75327d3ccf662aed3779fbfb0b730.html"}))
},963,[66,964]);`;

      await fs.mkdir(path.dirname(testFile), { recursive: true });
      await fs.writeFile(testFile, code, "utf-8");

      // Act
      const result = await transformDOMComponents(testFile);

      // Assert
      // The current transformer only handles JSX syntax, not React.createElement
      // This test documents the current limitation
      expect(result).toBe(false);

      const transformed = await fs.readFile(testFile, "utf-8");
      // Should remain unchanged as transformer doesn't handle createElement syntax
      expect(transformed).toContain(
        'filePath:"15b75327d3ccf662aed3779fbfb0b730.html"',
      );
      expect(transformed).not.toContain("overrideUri");

      // Cleanup
      await fs.rm(path.join(__dirname, "__test__"), { recursive: true });
    });
  });
});

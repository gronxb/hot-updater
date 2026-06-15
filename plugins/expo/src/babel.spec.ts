import { createRequire } from "node:module";

import { beforeEach, describe, expect, it, vi } from "vitest";

type TransformResult = {
  code?: string | null;
};

type TransformSync = (
  code: string,
  options: {
    filename?: string;
    plugins?: unknown[];
    presets?: unknown[];
    configFile: false;
    babelrc: false;
  },
) => TransformResult | null;

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core") as {
  transformSync: TransformSync;
};
const presetTypescript = require("@babel/preset-typescript") as unknown;

async function transformCode(code: string): Promise<string | null> {
  const { default: babelPlugin } = await import("./babel");
  const result = transformSync(code, {
    plugins: [babelPlugin],
    configFile: false,
    babelrc: false,
  });

  return result?.code ?? null;
}

async function transformTsxCode(
  code: string,
  useHotUpdaterPlugin: boolean,
  trailingPlugins: unknown[] = [],
): Promise<string | null> {
  const { default: babelPlugin } = await import("./babel");
  const result = transformSync(code, {
    filename: "App.tsx",
    presets: [[presetTypescript, { allExtensions: true, isTSX: true }]],
    plugins: useHotUpdaterPlugin ? [babelPlugin, ...trailingPlugins] : [],
    configFile: false,
    babelrc: false,
  });

  return result?.code ?? null;
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
        const domProps = {
          dom: { backgroundColor: "white" },
          style: { flex: 1 }
        };
        React.createElement(WebView, {
          ...domProps,
          filePath: "index.html"
        });
      `);

      expect(result).toMatch(
        /React\.createElement\(WebView,\s*\{\s*\.\.\.domProps,\s*\.\.\.\(/s,
      );
      expect(result).toContain("...domProps.dom");
      expect(result).toContain("overrideUri");
    });

    it("transforms JSX WebView filePath attributes into overrideUri spreads", async () => {
      const result = await transformTsxCode(
        `
          import { WebView } from "react-native-webview";

          export function DomComponent() {
            return <WebView filePath="index.html" />;
          }
        `,
        true,
      );

      expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      expect(result).toContain('"www.bundle"');
      expect(result).toContain("overrideUri");
      expect(result).toContain('"index.html"');
    });

    it("transforms JSX WebView filePath variables before trailing Babel plugins", async () => {
      const trailingPlugin = () => ({
        name: "trailing-test-plugin",
        visitor: {},
      });

      const result = await transformTsxCode(
        `
          import { WebView } from "react-native-webview";

          const filePath = "component.html";

          export function DomComponent() {
            return <WebView filePath={filePath} />;
          }
        `,
        true,
        [trailingPlugin],
      );

      expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      expect(result).toContain("overrideUri");
      expect(result).toContain('"component.html"');
    });

    it("transforms automatic JSX runtime WebView calls", async () => {
      const result = await transformCode(`
        (0, jsxRuntime.jsx)(WebView, { filePath: "index.html" });
      `);

      expect(result).toContain("globalThis.HotUpdaterGetBaseURL");
      expect(result).toContain("overrideUri");
      expect(result).toContain('"index.html"');
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

    it("does not change ordinary Expo app files without DOM filePath props", async () => {
      const appCode = `
        import { StatusBar } from "expo-status-bar";
        import { useMemo, useState } from "react";
        import { Button, Platform, ScrollView, Text, View } from "react-native";
        import {
          checkAndApplyUpdates,
          getHotUpdaterDiagnostics,
          initHotUpdater,
        } from "./hotUpdater";

        initHotUpdater();

        export default function App() {
          const [status, setStatus] = useState("Release build installed.");
          const diagnostics = useMemo(
            () => [["Platform", Platform.OS], ...getHotUpdaterDiagnostics()],
            [],
          );

          const checkForUpdate = () => {
            setStatus("Checking for update...");
            checkAndApplyUpdates(setStatus).catch((error: unknown) => {
              setStatus(error instanceof Error ? error.message : String(error));
            });
          };

          return (
            <ScrollView>
              <Text>{status}</Text>
              <View>
                <Button title="Check and apply update" onPress={checkForUpdate} />
              </View>
              <View>
                {diagnostics.map(([label, value]) => (
                  <View key={label}>
                    <Text>{label}</Text>
                    <Text>{value}</Text>
                  </View>
                ))}
              </View>
              <StatusBar style="auto" />
            </ScrollView>
          );
        }
      `;

      const withoutPlugin = await transformTsxCode(appCode, false);
      const withPlugin = await transformTsxCode(appCode, true);

      expect(withPlugin).toBe(withoutPlugin);
      expect(withPlugin).not.toContain("HotUpdaterGetBaseURL");
      expect(withPlugin).not.toContain("overrideUri");
    });

    it("does not change ordinary Expo registerRootComponent entry files", async () => {
      const entryCode = `
        import { registerRootComponent } from "expo";

        import App from "./App";

        registerRootComponent(App);
      `;

      const withoutPlugin = await transformTsxCode(entryCode, false);
      const withPlugin = await transformTsxCode(entryCode, true);

      expect(withPlugin).toBe(withoutPlugin);
      expect(withPlugin).toContain("registerRootComponent(App)");
    });
  });
});

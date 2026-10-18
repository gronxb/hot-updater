import { describe, expect, it } from "vitest";

import { setBareEntryFile } from "./bare-build-config.ts";

const config = (build: string) =>
  `export default defineConfig({\n  ${build},\n  updateStrategy: "appVersion",\n});\n`;

describe("bare build entry file", () => {
  it("builds the widget's entry for a widget deploy and the default again after it", () => {
    const example = config(
      "build: bare({ enableHermes: true, resetCache: false })",
    );

    const widget = setBareEntryFile(example, "index.widget.js");
    expect(widget).toBe(
      config(
        'build: bare({ enableHermes: true, resetCache: false, entryFile: "index.widget.js" })',
      ),
    );
    // A second widget deploy keeps one entry file.
    expect(setBareEntryFile(widget, "index.widget.js")).toBe(widget);
    // A main deploy after it drops the widget's entry.
    expect(setBareEntryFile(widget, null)).toBe(example);
  });

  it("replaces an entry file in the middle of the options", () => {
    expect(
      setBareEntryFile(
        config(
          "build: bare({ enableHermes: true, entryFile: 'index.js', resetCache: false })",
        ),
        null,
      ),
    ).toBe(config("build: bare({ enableHermes: true, resetCache: false })"));
  });

  it("refuses a widget deploy when the config has no inline bare build", () => {
    const multiline = config(
      "build: bare({\n    enableHermes: true,\n    resetCache: false,\n  })",
    );

    expect(setBareEntryFile(multiline, null)).toBe(multiline);
    expect(() => setBareEntryFile(multiline, "index.widget.js")).toThrow(
      "Failed to locate an inline build: bare",
    );
  });
});

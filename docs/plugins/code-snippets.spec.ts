import { rehypeCode } from "fumadocs-core/mdx-plugins/rehype-code";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { codeSnippetTransformers } from "./code-snippets";

type Root = Parameters<ReturnType<typeof rehypeCode>>[0];
type Node = Root | Root["children"][number];

function text(node: Node): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(text).join("") : "";
}

async function renderSnippet(lang: string, code: string) {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: [`language-${lang}`] },
            children: [{ type: "text", value: code }],
          },
        ],
      },
    ],
  };
  const rendered = await unified()
    .use(rehypeCode, { transformers: codeSnippetTransformers })
    .run(tree);
  const lines: { value: string; classes: (string | number)[] }[] = [];
  function collect(node: Node) {
    if (node.type === "element") {
      const value = node.properties.class;
      const classes = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(/\s+/)
          : [];
      if (classes.includes("line")) {
        lines.push({ value: text(node), classes });
        return;
      }
    }
    if ("children" in node) node.children.forEach(collect);
  }
  collect(rendered);
  return lines;
}

describe("code snippet diffs", () => {
  it("shows both sides of a replacement while copying only the applied code", async () => {
    const lines = await renderSnippet(
      "ts",
      "const unchanged = true;\nconst version = 0; // [!code --]\nconst version = 1; // [!code ++]",
    );
    expect(lines.map((line) => line.value.trim())).toEqual([
      "const unchanged = true;",
      "const version = 0;",
      "const version = 1;",
    ]);
    expect(lines[1]?.classes).toEqual(
      expect.arrayContaining(["diff", "remove", "nd-copy-ignore"]),
    );
    expect(lines[2]?.classes).toEqual(expect.arrayContaining(["diff", "add"]));
    expect(
      lines
        .filter((line) => !line.classes.includes("nd-copy-ignore"))
        .map((line) => line.value.trim()),
    ).toEqual(["const unchanged = true;", "const version = 1;"]);
  });

  it("keeps the context line after a multi-line removal copyable", async () => {
    const lines = await renderSnippet(
      "ts",
      '// [!code --:2]\nconst oldURL = "legacy";\nconnect(oldURL);\n// [!code ++:2]\nconst baseURL = "current";\nconnect(baseURL);\nstartApp();',
    );
    expect(
      lines.filter((line) => line.classes.includes("nd-copy-ignore")),
    ).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ value: "startApp();", classes: ["line"] });
    expect(lines.some((line) => line.value.includes("[!code"))).toBe(false);
  });

  it.each([
    ["jsonc", '  "enabled": true // [!code ++]'],
    ["xml", "<key>HOT_UPDATER_CHANNEL</key> <!-- [!code ++] -->"],
    ["yaml", "channel: production # [!code ++]"],
  ])(
    "handles %s comments without leaking notation into copied code",
    async (lang, code) => {
      const lines = await renderSnippet(lang, code);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.classes).toEqual(
        expect.arrayContaining(["diff", "add"]),
      );
      expect(lines[0]?.classes).not.toContain("nd-copy-ignore");
      expect(lines[0]?.value).not.toContain("[!code");
    },
  );
});

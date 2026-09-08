import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getLLMText } from "../src/lib/get-llm-text";
import { orderedPages, parseDocument, readDocumentation } from "./docs-content";
import { generateDocumentationFiles, llmsIndex } from "./llms-txt-plugin";
import { validateDocumentation } from "./validate-docs";

const temporaryDirectories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hot-updater-docs-"));
  temporaryDirectories.push(dir);
  function write(path: string, content: string | object) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  write("meta.json", { root: true, pages: ["start", "operate"] });
  write("start/meta.json", { title: "Start here", pages: ["../guides/start"] });
  write("operate/meta.json", {
    title: "Operate",
    pages: ["../guides/console-deployment"],
  });
  write(
    "guides/start.mdx",
    "---\ntitle: Start\n---\n## Verify\n\n[Console](/docs/guides/console-deployment#connect)\n",
  );
  write("guides/console-deployment/meta.json", {
    title: "Console hosting",
    pages: ["index", "zeta", "alpha"],
  });
  write(
    "guides/console-deployment/index.mdx",
    "---\ntitle: Console\n---\n## Connect\n",
  );
  write(
    "guides/console-deployment/zeta.mdx",
    "---\ntitle: Zeta\n---\n## Deploy\n",
  );
  write(
    "guides/console-deployment/alpha.mdx",
    "---\ntitle: Alpha\n---\n## Deploy\n",
  );
  return { dir, write };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("agent documentation", () => {
  it("uses task metadata and canonical nested index URLs for every machine output", async () => {
    const { dir } = fixture();
    const documentation = readDocumentation(dir);
    expect(orderedPages(documentation).map((page) => page.url)).toEqual([
      "/docs/guides/start",
      "/docs/guides/console-deployment",
      "/docs/guides/console-deployment/zeta",
      "/docs/guides/console-deployment/alpha",
    ]);
    const output = join(dir, "output");
    await generateDocumentationFiles({
      baseUrl: "https://hot-updater.dev",
      contentDir: dir,
      outputDir: output,
    });
    const index = readFileSync(join(output, "llms.txt"), "utf8");
    expect(
      [...index.matchAll(/https:\/\/hot-updater.dev([^)]*)/g)].map(
        (match) => match[1],
      ),
    ).toEqual(orderedPages(documentation).map((page) => `${page.url}.md`));
    const canonical = readFileSync(
      join(output, "docs/guides/console-deployment.md"),
      "utf8",
    );
    expect(canonical).toContain(
      "# Console (https://hot-updater.dev/docs/guides/console-deployment)",
    );
    expect(
      readFileSync(
        join(output, "api/markdown/guides/console-deployment.md"),
        "utf8",
      ),
    ).toBe(canonical);
    expect(
      await getLLMText({
        url: "/docs/guides/console-deployment",
        data: {
          title: "Console",
          getText: async () =>
            readFileSync(
              join(dir, "guides/console-deployment/index.mdx"),
              "utf8",
            ),
        },
      }),
    ).toBe(canonical);
    expect(
      readFileSync(
        join(output, "docs/guides/console-deployment/index.md"),
        "utf8",
      ),
    ).toBe(canonical);
    expect(index).not.toContain("console-deployment/index.md");

    const legacy = fixture();
    legacy.write(
      "guides/start.mdx",
      "---\ntitle: Legacy v0 setup\n---\n## Set up\n",
    );
    await generateDocumentationFiles({
      baseUrl: "https://hot-updater.dev",
      contentDir: legacy.dir,
      outputDir: output,
      urlPrefix: "v0",
      generateIndex: false,
    });
    expect(
      readFileSync(join(output, "docs/v0/guides/start.md"), "utf8"),
    ).toContain("Legacy v0 setup");
    expect(readFileSync(join(output, "llms.txt"), "utf8")).toBe(index);
    expect(readFileSync(join(output, "llms-full.txt"), "utf8")).not.toContain(
      "Legacy v0 setup",
    );
  });

  it("keeps alternative labels, paragraphs and native integration code in Markdown", () => {
    const code =
      'import React from "react";\nreturn oldBundle; // [!code --]\nreturn <App />; // [!code ++]';
    const raw = `---\ntitle: Setup\n---\nimport { Tabs, Tab } from "components";\n\n<Steps>\n<Step>\n## Choose\n\n<Tabs items={["Agent", "Terminal"]}>\n<Tab value="Agent">\nFirst paragraph.\n\nSecond paragraph.\n</Tab>\n<Tab value="Terminal">\n\n\`\`\`tsx\n${code}\n\`\`\`\n\n</Tab>\n</Tabs>\n</Step>\n</Steps>\n\n<Accordion title="Troubleshooting">\nTry again.\n</Accordion>\n`;
    const document = parseDocument(
      `${raw}\n[**Action**](https://example.org)\n\n![Preview](/preview.png)\n\n<a href="/docs/get-started/introduction">Start here</a>\n`,
    );
    expect(document.markdown).toContain("## Choose");
    expect(document.markdown).toContain("[**Action**](https://example.org)");
    expect(document.markdown).toContain("![Preview](/preview.png)");
    expect(document.markdown).toContain(
      "[Start here](/docs/get-started/introduction)",
    );
    expect(document.markdown).toContain("**Agent**");
    expect(document.markdown).toContain("**Terminal**");
    expect(document.markdown).toContain("**Troubleshooting**");
    expect(document.markdown).toContain(
      "First paragraph.\n\nSecond paragraph.",
    );
    expect(document.markdown).toContain(code);
    expect(document.markdown).not.toMatch(/<\/?(?:Steps?|Tabs?|Accordion)\b/);
    expect(document.markdown).not.toContain('from "components"');
  });

  it("rejects missing navigation, root links and fragments while accepting explicit anchors and assets", () => {
    const { dir, write } = fixture();
    write(
      "guides/start.mdx",
      '---\ntitle: Start\n---\n## Verify\n\n<a id="old-verify" />\n\n[Alias](#old-verify)\n\n[Existing](/docs/guides/console-deployment#connect)\n\n[Missing](/docs/missing)\n\n[Wrong heading](/docs/guides/console-deployment#missing)\n\n![Screenshot](/docs/screenshot.png)\n\n```md\n[Example](/docs/example-not-a-real-route)\n```\n',
    );
    write(
      "guides/forgotten.mdx",
      "---\ntitle: Forgotten\n---\n## Missing navigation\n",
    );
    write("operate/meta.json", {
      title: "Operate",
      pages: ["../guides/console-deployment", "missing-target"],
    });
    write("public/docs/screenshot.png", "fixture");
    write("public/docs/asset-directory/image.png", "fixture");
    write(
      "guides/console-deployment/alpha.mdx",
      "---\ntitle: Alpha\n---\n## Deploy\n\n[Directory is not a page](/docs/asset-directory#missing)\n",
    );
    const issues = validateDocumentation(
      readDocumentation(dir),
      join(dir, "public"),
    );
    expect(issues).toHaveLength(5);
    expect(issues.join("\n")).toContain(
      "guides/forgotten.mdx: appears 0 times in navigation",
    );
    expect(issues.join("\n")).toContain("missing page /docs/missing");
    expect(issues.join("\n")).toContain(
      "missing anchor /docs/guides/console-deployment#missing",
    );
    expect(issues.join("\n")).toContain(
      "missing navigation target missing-target",
    );
    expect(issues.join("\n")).toContain(
      "missing page /docs/asset-directory#missing",
    );
  });

  it("keeps every latest page discoverable exactly once with valid links and anchors", () => {
    const documentation = readDocumentation("content/docs/(latest)");
    const issues = validateDocumentation(documentation, "public");
    expect(issues).toEqual([]);
    const index = llmsIndex(documentation, "https://hot-updater.dev");
    const site = readDocumentation("content/docs");
    expect(
      orderedPages(site)
        .filter((page) => !page.url.startsWith("/docs/v0/"))
        .map((page) => page.url),
    ).toEqual(orderedPages(documentation).map((page) => page.url));
    expect(index).not.toContain("/docs/v0/");
    expect(index).not.toContain("(latest)");
    expect(index).toContain("/docs/guides/native-build.md");
    expect(orderedPages(documentation)[0]?.url).toBe(
      "/docs/get-started/introduction",
    );
  });
});

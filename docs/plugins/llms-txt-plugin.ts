import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Node } from "fumadocs-core/page-tree";
import { llms } from "fumadocs-core/source";
import type { Plugin, ResolvedConfig } from "vite";

import {
  type Documentation,
  orderedPages,
  pageMarkdown,
  readDocumentation,
} from "./docs-content";
import { validateDocumentation } from "./validate-docs";

interface LLMsTxtPluginOptions {
  baseUrl: string;
  contentDir?: string;
  generateIndex?: boolean;
  outputDir?: string;
  urlPrefix?: string;
}

export function llmsIndex(documentation: Documentation, baseUrl: string) {
  const { source } = documentation;
  const formatter = llms(source);
  function markdownUrls(node: Node): Node {
    if (node.type === "page") {
      return { ...node, url: `${baseUrl}${node.url}.md` };
    }
    if (node.type === "separator") return node;
    return {
      ...node,
      index: node.index
        ? (markdownUrls(node.index) as typeof node.index)
        : undefined,
      children: node.children.map(markdownUrls),
    };
  }
  const lines = [
    "# Hot Updater Documentation",
    "",
    "> Set up, deliver, and operate React Native OTA updates on your infrastructure.",
    "",
  ];
  for (const node of source.pageTree.children) {
    lines.push(formatter.indexNode(markdownUrls(node)), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export async function generateDocumentationFiles(
  options: LLMsTxtPluginOptions,
) {
  const {
    baseUrl,
    contentDir = "content/docs",
    generateIndex = true,
    outputDir = "dist/public",
    urlPrefix,
  } = options;
  const documentation = readDocumentation(contentDir, urlPrefix);
  const pages = orderedPages(documentation);
  if (generateIndex) {
    const issues = validateDocumentation(documentation, "public");
    if (issues.length > 0)
      throw new Error(`Documentation validation failed:\n${issues.join("\n")}`);
  }
  await mkdir(outputDir, { recursive: true });
  async function write(urlPath: string, content: string) {
    const outputPath = join(outputDir, urlPath.replace(/^\//, ""));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
  }
  await Promise.all([
    ...(generateIndex
      ? [
          write("llms.txt", llmsIndex(documentation, baseUrl)),
          write(
            "llms-full.txt",
            pages.map((page) => pageMarkdown(page, baseUrl)).join("\n\n"),
          ),
        ]
      : []),
    ...documentation.source.getPages().flatMap((page) => {
      const markdown = pageMarkdown(page, baseUrl);
      const paths = new Set([
        `${page.url}.md`,
        page.url.replace(/^\/docs\//, "/api/markdown/") + ".md",
        // Keep previously published filename-based Markdown aliases working.
        `/docs/${[urlPrefix, page.path.replace(/\.mdx?$/, "")].filter(Boolean).join("/")}.md`,
        `/api/markdown/${[urlPrefix, page.path.replace(/\.mdx?$/, "")].filter(Boolean).join("/")}.md`,
      ]);
      return [...paths].map((url) => write(url, markdown));
    }),
  ]);
}

export function llmsTxtPlugin(options: LLMsTxtPluginOptions): Plugin {
  let config: ResolvedConfig;
  return {
    name: "llms-txt-plugin",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async closeBundle() {
      if (config.command === "build") await generateDocumentationFiles(options);
    },
  };
}

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { createProcessor } from "@mdx-js/mdx";
import { remarkGfm, remarkHeading } from "fumadocs-core/mdx-plugins";
import { defaultStringifier } from "fumadocs-core/mdx-plugins/stringifier";
import type {
  Node as TreeNode,
  Root as TreeRoot,
} from "fumadocs-core/page-tree";
import {
  loader,
  type MetaData,
  type PageData,
  type VirtualFile,
} from "fumadocs-core/source";
import type { Nodes } from "mdast";
import { unified } from "unified";
import { VFile } from "vfile";
import { parse } from "yaml";

interface DocumentLink {
  url: string;
  line: number;
  asset: boolean;
}

interface DocumentData extends PageData {
  title: string;
  body: string;
  markdown: string;
  anchors: string[];
  links: DocumentLink[];
}

type Element = Extract<
  Nodes,
  { type: "mdxJsxFlowElement" | "mdxJsxTextElement" }
>;

function attribute(node: Element, name: string) {
  const attr = node.attributes.find(
    (item) => item.type === "mdxJsxAttribute" && item.name === name,
  );
  if (!attr || attr.type !== "mdxJsxAttribute") return undefined;
  if (typeof attr.value === "string") return attr.value;
  return attr.value?.value.match(/^(["'])([\s\S]*)\1$/)?.[2];
}

function visit(node: Nodes, callback: (node: Nodes) => void) {
  callback(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, callback);
  }
}

const processor = createProcessor({ remarkPlugins: [remarkGfm] });
const markdownProcessor = unified();
const stringify = defaultStringifier({
  filterElement(node) {
    if (node.type === "mdxjsEsm") return false;
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      return "children-only";
    }
    return true;
  },
  stringify(node, _parent, state, info) {
    if (
      node.type !== "mdxJsxFlowElement" &&
      node.type !== "mdxJsxTextElement"
    ) {
      return;
    }
    const label =
      node.name === "Tab"
        ? attribute(node, "value")
        : node.name === "Accordion"
          ? attribute(node, "title")
          : node.name === "Callout"
            ? attribute(node, "title") || attribute(node, "type") || "Note"
            : undefined;
    if (label) {
      const content =
        node.type === "mdxJsxFlowElement"
          ? state.containerFlow(node, info)
          : state.containerPhrasing(node, info);
      return `**${label}**\n\n${content}`;
    }
    const url = attribute(node, "href") || attribute(node, "src");
    if (url) {
      const children =
        node.type === "mdxJsxFlowElement"
          ? state.containerFlow(node, info)
          : state.containerPhrasing(node, info);
      const title =
        attribute(node, "title") ||
        attribute(node, "alt") ||
        children.trim() ||
        node.name;
      return `[${title}](${url})`;
    }
  },
});

export function parseDocument(raw: string): DocumentData {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const data = (frontmatter ? parse(frontmatter[1]!) : {}) as PageData;
  const body = raw.slice(frontmatter?.[0].length ?? 0);
  const offset = (frontmatter?.[0].match(/\n/g) ?? []).length;
  const tree = processor.parse(body);
  markdownProcessor.data(processor.data());
  remarkHeading({ generateToc: false })(tree, new VFile(body), () => {});
  const anchors: string[] = [];
  const links: DocumentLink[] = [];
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    const line = (node.position?.start.line ?? 1) + offset;
    if (node.type === "heading") {
      const id = node.data?.hProperties?.id;
      if (typeof id === "string") anchors.push(id);
    }
    if (node.type === "link" || node.type === "image") {
      links.push({ url: node.url, line, asset: node.type === "image" });
    }
    if (node.type === "linkReference" || node.type === "imageReference") {
      const url = definitions.get(node.identifier);
      if (url) links.push({ url, line, asset: node.type === "imageReference" });
    }
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      const id = attribute(node, "id");
      if (id) anchors.push(id);
      for (const name of ["href", "src"]) {
        const url = attribute(node, name);
        if (url) links.push({ url, line, asset: name === "src" });
      }
    }
  });
  return {
    ...data,
    title: data.title ?? "Untitled",
    body,
    markdown: stringify.call(markdownProcessor, tree, undefined),
    anchors,
    links,
  };
}

export function readDocumentation(contentRoot: string, urlPrefix?: string) {
  const files: VirtualFile<{ pageData: DocumentData; metaData: MetaData }>[] =
    [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const path = relative(contentRoot, absolutePath).replace(/\\/g, "/");
      if (entry.name === "meta.json") {
        files.push({
          type: "meta",
          path,
          absolutePath,
          data: JSON.parse(readFileSync(absolutePath, "utf8")) as MetaData,
        });
      } else if (/\.mdx?$/.test(entry.name)) {
        files.push({
          type: "page",
          path,
          absolutePath,
          data: parseDocument(readFileSync(absolutePath, "utf8")),
        });
      }
    }
  }
  walk(contentRoot);
  const source = loader({
    source: { files },
    baseUrl: urlPrefix ? `/docs/${urlPrefix}` : "/docs",
  });
  return { files, source };
}

export type Documentation = ReturnType<typeof readDocumentation>;
export type DocumentPage = ReturnType<
  Documentation["source"]["getPages"]
>[number];

export function orderedPages({ source }: Documentation) {
  const pages: DocumentPage[] = [];
  function walk(node: TreeNode | TreeRoot) {
    if (node.type === "page") {
      const page = source.getNodePage(node);
      if (page) pages.push(page);
    } else if (node.type !== "separator") {
      if ("index" in node && node.index) walk(node.index);
      for (const child of node.children) walk(child);
    }
  }
  walk(source.pageTree);
  return pages;
}

export function pageMarkdown(page: DocumentPage, baseUrl: string) {
  const summary = page.data.description ? `\n\n> ${page.data.description}` : "";
  return `# ${page.data.title} (${baseUrl}${page.url})${summary}\n\n${page.data.markdown}`;
}

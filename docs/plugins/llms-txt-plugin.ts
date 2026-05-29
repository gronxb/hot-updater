import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

interface LLMsTxtPluginOptions {
  baseUrl: string;
  contentDir?: string;
  outputDir?: string;
}

interface DocPage {
  title: string;
  description: string;
  pageUrl: string;
  markdownUrl: string;
  apiMarkdownUrl: string;
  category: string;
  body: string;
}

interface Category {
  title: string;
  pages: string[];
}

export function llmsTxtPlugin(options: LLMsTxtPluginOptions): Plugin {
  const {
    baseUrl,
    contentDir = "content/docs",
    outputDir = "dist/public",
  } = options;

  let config: ResolvedConfig;

  async function generateFiles() {
    const contentRoot = join(process.cwd(), contentDir);
    const outputRoot = join(process.cwd(), outputDir);
    const categories = collectCategories(contentRoot);
    const pages = collectDocPages(contentRoot, categories);

    await mkdir(outputRoot, { recursive: true });
    await Promise.all([
      writeFile(
        join(outputRoot, "llms.txt"),
        generateLLMsIndex(pages, categories, baseUrl),
        "utf-8",
      ),
      writeFile(
        join(outputRoot, "llms-full.txt"),
        generateLLMsFull(pages, baseUrl),
        "utf-8",
      ),
      ...pages.flatMap((page) => [
        writeMarkdownPage(outputRoot, page.markdownUrl, page, baseUrl),
        writeMarkdownPage(outputRoot, page.apiMarkdownUrl, page, baseUrl),
      ]),
    ]);
  }

  return {
    name: "llms-txt-plugin",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async closeBundle() {
      if (config.command === "build") {
        await generateFiles();
      }
    },
  };
}

function collectCategories(contentRoot: string) {
  const rootMeta = readJson(join(contentRoot, "meta.json"));
  const orderedPages = Array.isArray(rootMeta?.pages) ? rootMeta.pages : [];
  const categories = new Map<string, Category>();

  for (const page of orderedPages) {
    if (typeof page !== "string") continue;

    const meta = readJson(join(contentRoot, page, "meta.json"));
    categories.set(page, {
      title: typeof meta?.title === "string" ? meta.title : humanize(page),
      pages: Array.isArray(meta?.pages)
        ? meta.pages.filter((item): item is string => typeof item === "string")
        : [],
    });
  }

  return categories;
}

function collectDocPages(
  contentRoot: string,
  categories: Map<string, Category>,
) {
  const pages: DocPage[] = [];

  for (const [categorySlug, category] of categories) {
    const categoryRoot = join(contentRoot, categorySlug);
    const categoryPages = collectMdxFiles(categoryRoot, contentRoot);
    const ordered = orderPages(categoryPages, category.pages);

    pages.push(
      ...ordered.map((page) => ({
        ...page,
        category: categorySlug,
      })),
    );
  }

  return pages;
}

function collectMdxFiles(dir: string, contentRoot: string) {
  if (!existsSync(dir)) return [];

  const pages: Omit<DocPage, "category">[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      pages.push(...collectMdxFiles(fullPath, contentRoot));
      continue;
    }

    if (!entry.name.endsWith(".mdx") && !entry.name.endsWith(".md")) {
      continue;
    }

    const raw = readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(raw);
    const sourcePath = relative(contentRoot, fullPath)
      .replace(/\\/g, "/")
      .replace(/\.mdx?$/, "");
    const markdownSegments = sourcePath.split("/");
    const markdownLast = markdownSegments.at(-1)!;
    const markdownPath = [
      ...markdownSegments.slice(0, -1),
      `${markdownLast}.md`,
    ].join("/");
    const title =
      frontmatter.title || humanize(entry.name.replace(/\.mdx?$/, ""));

    pages.push({
      title,
      description: frontmatter.description || "",
      pageUrl: `/docs/${sourcePath}`,
      markdownUrl: `/docs/${sourcePath}.md`,
      apiMarkdownUrl: `/api/markdown/${markdownPath}`,
      body,
    });
  }

  return pages;
}

function orderPages<T extends { pageUrl: string }>(
  pages: T[],
  order: string[],
) {
  const rank = new Map(order.map((slug, index) => [slug, index]));

  return pages.sort((a, b) => {
    const aSlug = a.pageUrl.split("/").at(-1) ?? "";
    const bSlug = b.pageUrl.split("/").at(-1) ?? "";
    const aRank = rank.get(aSlug) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(bSlug) ?? Number.MAX_SAFE_INTEGER;

    return aRank - bRank || a.pageUrl.localeCompare(b.pageUrl);
  });
}

function generateLLMsIndex(
  pages: DocPage[],
  categories: Map<string, Category>,
  baseUrl: string,
) {
  const lines = [
    "# Hot Updater Documentation",
    "",
    "> React Native OTA updates powered by your own infrastructure.",
    "",
  ];

  for (const [slug, category] of categories) {
    const categoryPages = pages.filter((page) => page.category === slug);
    if (categoryPages.length === 0) continue;

    lines.push(`## ${category.title}`, "");

    for (const page of categoryPages) {
      const description = page.description ? `: ${page.description}` : "";
      lines.push(
        `- [${page.title}](${baseUrl}${page.markdownUrl})${description}`,
      );
    }

    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function generateLLMsFull(pages: DocPage[], baseUrl: string) {
  return `${pages
    .map((page) => generatePageMarkdown(page, baseUrl).trimEnd())
    .join("\n\n")}\n`;
}

async function writeMarkdownPage(
  outputRoot: string,
  urlPath: string,
  page: DocPage,
  baseUrl: string,
) {
  const outputPath = join(outputRoot, urlPath.slice(1));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generatePageMarkdown(page, baseUrl), "utf-8");
}

function generatePageMarkdown(page: DocPage, baseUrl: string) {
  const summary = page.description ? `\n\n> ${page.description}` : "";

  return `# ${page.title} (${baseUrl}${page.pageUrl})${summary}\n\n${cleanMdx(page.body)}\n`;
}

function splitFrontmatter(raw: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: raw };

  const frontmatter = match[1] ?? "";

  return {
    frontmatter: Object.fromEntries(
      frontmatter
        .split("\n")
        .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
        .filter((item): item is RegExpMatchArray => item !== null)
        .map((item) => [
          item[1] ?? "",
          (item[2] ?? "").replace(/^["']|["']$/g, ""),
        ]),
    ) as Record<string, string>,
    body: raw.slice(match[0].length),
  };
}

function cleanMdx(body: string) {
  const componentTag =
    /<\/?(Tabs|Tab|Accordions|Accordion|Callout)(\s[^>]*)?>/g;
  let inCodeBlock = false;

  return body
    .split("\n")
    .flatMap((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeBlock = !inCodeBlock;
        return line;
      }

      if (inCodeBlock) {
        return line;
      }

      if (/^\s*import\s+.*?;?\s*$/.test(line)) {
        return [];
      }

      const cleaned = line.replace(componentTag, "").trimEnd();
      return cleaned.trim().length > 0 ? cleaned : [];
    })
    .join("\n")
    .trim();
}

function readJson(path: string) {
  if (!existsSync(path)) return undefined;

  return JSON.parse(readFileSync(path, "utf-8")) as
    | Record<string, unknown>
    | undefined;
}

function humanize(value: string) {
  return value
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

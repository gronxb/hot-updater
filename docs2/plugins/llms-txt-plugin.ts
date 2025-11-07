import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

interface LLMPluginOptions {
  baseUrl: string;
  githubRepo?: string;
  contentDir?: string;
  outputDir?: string;
}

interface PackageJson {
  name?: string;
  description?: string;
  repository?: string | { url?: string };
}

function getPackageInfo(): { name: string; description: string; repo?: string } {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));

      let repo: string | undefined;
      if (typeof pkg.repository === "string") {
        repo = pkg.repository;
      } else if (pkg.repository?.url) {
        repo = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
      }

      return {
        name: pkg.name || "Documentation",
        description: pkg.description || "",
        repo,
      };
    }
  } catch (error) {
    console.warn("Failed to read package.json:", error);
  }

  return { name: "Documentation", description: "" };
}

function humanizeDirectoryName(dirName: string): string {
  return dirName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getCategoryMetadata(contentDir: string): Record<string, string> {
  const categoryMap: Record<string, string> = {};

  try {
    const entries = readdirSync(contentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirName = entry.name;
        const metaPath = join(contentDir, dirName, "meta.json");

        // Try to read meta.json for the category title
        if (existsSync(metaPath)) {
          try {
            const metaContent = readFileSync(metaPath, "utf-8");
            const meta = JSON.parse(metaContent);

            // Check for title in various possible locations
            const title =
              meta.title || meta.root?.title || humanizeDirectoryName(dirName);
            categoryMap[dirName] = title;
          } catch (_error) {
            // If parsing fails, use humanized name
            categoryMap[dirName] = humanizeDirectoryName(dirName);
          }
        } else {
          // No meta.json, use humanized directory name
          categoryMap[dirName] = humanizeDirectoryName(dirName);
        }
      }
    }
  } catch (error) {
    console.warn("Failed to generate category metadata:", error);
  }

  return categoryMap;
}

export function llmsTxtPlugin(options: LLMPluginOptions): Plugin {
  const {
    baseUrl,
    githubRepo: userGithubRepo,
    contentDir: userContentDir = "content/docs",
    outputDir = ".output/public",
  } = options;

  const pkgInfo = getPackageInfo();
  const githubRepo = userGithubRepo || pkgInfo.repo;

  let config: ResolvedConfig;
  let categoryMap: Record<string, string> = {};
  let categoryOrder: string[] = [];

  function getCategoryFromPath(url: string): string {
    const match = url.match(/\/docs\/([^/]+)/);
    if (!match || !match[1]) return "Documentation";
    const key = match[1];
    return categoryMap[key] || humanizeDirectoryName(key);
  }

  async function generateFiles() {
    try {
      const contentDir = join(process.cwd(), userContentDir);

      // Generate category map from directory structure
      categoryMap = getCategoryMetadata(contentDir);
      categoryOrder = Object.keys(categoryMap).sort();

      const pages = await collectMDXFiles(contentDir);

      // Generate llms.txt (summary)
      const llmsSummary = generateLLMsSummary(
        pages,
        baseUrl,
        pkgInfo,
        categoryMap,
        categoryOrder,
        getCategoryFromPath,
      );

      // Generate llms-full.txt (full content)
      const llmsFull = generateLLMsFull(
        pages,
        baseUrl,
        pkgInfo,
        githubRepo,
        getCategoryFromPath,
      );

      // Write to build output directory only
      const outputPath = join(process.cwd(), outputDir);
      await mkdir(outputPath, { recursive: true });
      await writeFile(join(outputPath, "llms.txt"), llmsSummary, "utf-8");
      await writeFile(join(outputPath, "llms-full.txt"), llmsFull, "utf-8");

      console.log(
        "✓ Generated llms.txt and llms-full.txt for production build",
      );
      console.log(
        `  Found ${Object.keys(categoryMap).length} categories:`,
        Object.keys(categoryMap).join(", "),
      );
    } catch (error) {
      console.error("Failed to generate LLM text files:", error);
      console.error(error);
    }
  }

  return {
    name: "llms-txt-plugin",

    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
    },

    async closeBundle() {
      // Only generate files during production build
      if (config?.command === "build") {
        await generateFiles();
      }
    },
  };
}

interface MDXPage {
  title: string;
  description?: string;
  url: string;
  path: string;
  body: string;
}

async function collectMDXFiles(dir: string, baseDir = dir): Promise<MDXPage[]> {
  const pages: MDXPage[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const subPages = await collectMDXFiles(fullPath, baseDir);
      pages.push(...subPages);
    } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        let title = entry.name.replace(/\.mdx?$/, "");
        let description = "";

        if (frontmatterMatch && frontmatterMatch[1]) {
          const frontmatter = frontmatterMatch[1];
          const titleMatch = frontmatter.match(/title:\s*(.+)/);
          const descMatch = frontmatter.match(/description:\s*(.+)/);

          if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();
          if (descMatch && descMatch[1]) description = descMatch[1].trim();
        }

        const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
        const relativePath = fullPath
          .replace(baseDir, "")
          .replace(/\.mdx?$/, "")
          .replace(/\\/g, "/");

        const url = `/docs${relativePath === "/index" ? "" : relativePath}`;

        pages.push({
          title,
          description,
          url,
          path: relativePath,
          body,
        });
      } catch (error) {
        console.warn(`Failed to parse ${fullPath}:`, error);
      }
    }
  }

  return pages;
}

function generateLLMsSummary(
  pages: MDXPage[],
  baseUrl: string,
  pkgInfo: { name: string; description: string },
  categoryMap: Record<string, string>,
  categoryOrder: string[],
  _getCategoryFromPath: (url: string) => string,
): string {
  // Group pages by category
  const categories = new Map<string, MDXPage[]>();

  for (const page of pages) {
    const match = page.url.match(/\/docs\/([^/]+)/);
    const category = match && match[1] ? match[1] : "other";

    if (!categories.has(category)) {
      categories.set(category, []);
    }
    categories.get(category)?.push(page);
  }

  let summary = `# ${pkgInfo.name} Documentation\n`;

  if (pkgInfo.description) {
    summary += `\n${pkgInfo.description}\n`;
  }

  summary += `\n## Documentation Structure\n\n`;

  // Use dynamically generated category order
  for (const categoryKey of categoryOrder) {
    const categoryPages = categories.get(categoryKey);
    if (!categoryPages || categoryPages.length === 0) continue;

    const categoryName =
      categoryMap[categoryKey] || humanizeDirectoryName(categoryKey);

    summary += `### ${categoryName}\n\n`;

    for (const page of categoryPages.slice(0, 5)) {
      // Limit to top 5 per category
      summary += `- [${page.title}](${baseUrl}${page.url})`;
      if (page.description) {
        summary += ` - ${page.description}`;
      }
      summary += "\n";
    }

    summary += "\n";
  }

  summary += `\nFor full documentation, see: ${baseUrl}/docs\n`;

  return summary;
}

function generateLLMsFull(
  pages: MDXPage[],
  baseUrl: string,
  pkgInfo: { name: string; description: string },
  githubRepo: string | undefined,
  getCategoryFromPath: (url: string) => string,
): string {
  let fullContent = `# ${pkgInfo.name} - Complete Documentation\n\n`;

  if (pkgInfo.description) {
    fullContent += `${pkgInfo.description}\n\n`;
  }

  fullContent += `---\n\n`;

  for (const page of pages) {
    const category = getCategoryFromPath(page.url);
    const title = page.title || "Untitled";
    const description = page.description || "";
    const url = `${baseUrl}${page.url}`;

    fullContent += `# ${category}: ${title}\n`;
    fullContent += `URL: ${url}\n`;

    if (githubRepo) {
      const sourcePath = page.path.replace(/^\//, "");
      const sourceUrl = `${githubRepo}/blob/main/content/docs/${sourcePath}.mdx`;
      fullContent += `Source: ${sourceUrl}\n`;
    }

    fullContent += `\n`;

    if (description) {
      fullContent += `${description}\n\n`;
    }

    // Remove JSX/MDX syntax and add raw text
    const cleanBody = page.body
      .replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/```[\s\S]*?```/g, (match) => match)
      .trim();

    fullContent += `${cleanBody}\n`;
    fullContent += `\n---\n\n`;
  }

  return fullContent;
}

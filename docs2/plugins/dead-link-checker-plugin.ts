import type { Plugin, ResolvedConfig } from "vite";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

interface DeadLinkCheckerOptions {
  contentDir: string;
  failOnError?: boolean;
  exclude?: RegExp[];
  checkOnDev?: boolean;
}

interface LinkIssue {
  file: string;
  line: number;
  link: string;
  rawLink: string;
  resolvedPath: string;
  issue: string;
  suggestion?: string;
}

export function deadLinkCheckerPlugin(
  options: DeadLinkCheckerOptions,
): Plugin {
  let config: ResolvedConfig;

  const {
    contentDir,
    failOnError = false,
    exclude = [/^https?:\/\//, /^#/, /^mailto:/],
    checkOnDev = true,
  } = options;

  function isExcluded(link: string): boolean {
    return exclude.some((pattern) => pattern.test(link));
  }

  function getAllMdxFiles(dir: string): string[] {
    const files: string[] = [];

    function walk(currentDir: string) {
      const items = readdirSync(currentDir);

      for (const item of items) {
        const fullPath = join(currentDir, item);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (item.endsWith(".mdx")) {
          files.push(fullPath);
        }
      }
    }

    walk(dir);
    return files;
  }

  function extractLinks(content: string, filePath: string): LinkIssue[] {
    const issues: LinkIssue[] = [];
    const lines = content.split("\n");

    // Match markdown links: [text](path)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;

      while ((match = linkRegex.exec(line)) !== null) {
        const linkText = match[1];
        const linkPath = match[2];

        // Skip excluded links
        if (isExcluded(linkPath)) {
          continue;
        }

        // Only check relative links
        if (!linkPath.startsWith(".")) {
          continue;
        }

        const issue = validateLink(filePath, linkPath, linkText);
        if (issue) {
          issues.push({
            ...issue,
            line: i + 1,
          });
        }
      }
    }

    return issues;
  }

  function validateLink(
    sourceFile: string,
    linkPath: string,
    linkText: string,
  ): Omit<LinkIssue, "line"> | null {
    const sourceDir = dirname(sourceFile);
    const contentRoot = resolve(config.root, contentDir);

    // Resolve the relative path from source file
    let resolvedPath = resolve(sourceDir, linkPath);

    // Remove any hash fragments
    const hashIndex = resolvedPath.indexOf("#");
    if (hashIndex !== -1) {
      resolvedPath = resolvedPath.substring(0, hashIndex);
    }

    // Get relative path from content root for display
    const displayPath = relative(contentRoot, resolvedPath);

    // Check if path exists as a file (with or without .mdx)
    if (existsSync(resolvedPath)) {
      if (statSync(resolvedPath).isFile()) {
        return null; // Valid file link
      }
    }

    // Try with .mdx extension
    const mdxPath = resolvedPath.endsWith(".mdx")
      ? resolvedPath
      : `${resolvedPath}.mdx`;
    if (existsSync(mdxPath) && statSync(mdxPath).isFile()) {
      return null; // Valid file link
    }

    // Check if it's a folder
    if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
      // Check for index.mdx in folder
      const indexPath = join(resolvedPath, "index.mdx");
      if (existsSync(indexPath)) {
        return null; // Valid folder with index
      }

      // Check if folder has pages in meta.json
      const metaPath = join(resolvedPath, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          if (meta.pages && meta.pages.length > 0) {
            // Suggest first page
            const firstPage = meta.pages[0];
            return {
              file: relative(config.root, sourceFile),
              link: linkText,
              rawLink: linkPath,
              resolvedPath: displayPath,
              issue: "Link points to folder without index.mdx",
              suggestion: `Use [${linkText}](${linkPath}/${firstPage})`,
            };
          }
        } catch (e) {
          // Invalid meta.json, continue to return error
        }
      }

      return {
        file: relative(config.root, sourceFile),
        link: linkText,
        rawLink: linkPath,
        resolvedPath: displayPath,
        issue: "Link points to folder without index.mdx or pages in meta.json",
        suggestion: "Create an index.mdx file or link to a specific page",
      };
    }

    // Path doesn't exist at all
    return {
      file: relative(config.root, sourceFile),
      link: linkText,
      rawLink: linkPath,
      resolvedPath: displayPath,
      issue: "File or folder does not exist",
      suggestion: "Check the path or create the missing file",
    };
  }

  function checkDeadLinks(): LinkIssue[] {
    const contentRoot = resolve(config.root, contentDir);
    const allIssues: LinkIssue[] = [];

    if (!existsSync(contentRoot)) {
      console.error(
        `[dead-link-checker] Content directory not found: ${contentRoot}`,
      );
      return allIssues;
    }

    const mdxFiles = getAllMdxFiles(contentRoot);

    for (const file of mdxFiles) {
      const content = readFileSync(file, "utf-8");
      const issues = extractLinks(content, file);
      allIssues.push(...issues);
    }

    return allIssues;
  }

  function reportIssues(issues: LinkIssue[]) {
    if (issues.length === 0) {
      console.log(
        "\x1b[32m✓\x1b[0m [dead-link-checker] No dead links found!",
      );
      return;
    }

    console.log(
      `\n\x1b[33m⚠\x1b[0m [dead-link-checker] Found ${issues.length} dead link(s):\n`,
    );

    // Group by file
    const byFile = issues.reduce(
      (acc, issue) => {
        if (!acc[issue.file]) {
          acc[issue.file] = [];
        }
        acc[issue.file].push(issue);
        return acc;
      },
      {} as Record<string, LinkIssue[]>,
    );

    for (const [file, fileIssues] of Object.entries(byFile)) {
      console.log(`\x1b[36m${file}\x1b[0m`);
      for (const issue of fileIssues) {
        console.log(`  \x1b[31m✗\x1b[0m Line ${issue.line}: [${issue.link}](${issue.rawLink})`);
        console.log(`    Resolved to: ${issue.resolvedPath}`);
        console.log(`    Issue: ${issue.issue}`);
        if (issue.suggestion) {
          console.log(`    \x1b[32mSuggestion:\x1b[0m ${issue.suggestion}`);
        }
        console.log();
      }
    }

    if (failOnError) {
      throw new Error(
        `[dead-link-checker] Found ${issues.length} dead link(s). Build failed.`,
      );
    }
  }

  return {
    name: "dead-link-checker",

    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
    },

    configureServer() {
      if (checkOnDev && config.command === "serve") {
        // Run check when dev server starts
        setTimeout(() => {
          const issues = checkDeadLinks();
          reportIssues(issues);
        }, 1000);
      }
    },

    async closeBundle() {
      // Run check after production build
      if (config.command === "build") {
        const issues = checkDeadLinks();
        reportIssues(issues);
      }
    },
  };
}

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { type Documentation, orderedPages } from "./docs-content";

export function validateDocumentation(
  documentation: Documentation,
  publicDir: string,
) {
  const issues: string[] = [];
  const pages = documentation.source.getPages();
  const routes = new Map(pages.map((page) => [page.url, page]));
  const counts = new Map<string, number>();
  for (const page of orderedPages(documentation)) {
    counts.set(page.url, (counts.get(page.url) ?? 0) + 1);
  }
  for (const page of pages) {
    const count = counts.get(page.url) ?? 0;
    if (count !== 1)
      issues.push(`${page.path}: appears ${count} times in navigation`);
  }

  function checkLink(
    url: string,
    fromUrl: string,
    location: string,
    asset = false,
  ) {
    const target = new URL(url, `https://hot-updater.dev${fromUrl}`);
    if (target.origin !== "https://hot-updater.dev") return;
    const publicPath = join(publicDir, target.pathname);
    if (existsSync(publicPath) && statSync(publicPath).isFile()) return;
    if (asset) {
      issues.push(`${location}: missing asset ${url}`);
      return;
    }
    const pathname = target.pathname
      .replace(/\/$/, "")
      .replace(/^\/api\/markdown\//, "/docs/")
      .replace(/\.mdx?$/, "");
    if (pathname === "/llms.txt" || pathname === "/llms-full.txt") return;
    const canonical =
      pathname === "/docs" ? "/docs/get-started/introduction" : pathname;
    const page = routes.get(canonical);
    if (!page) {
      issues.push(`${location}: missing page ${url}`);
    } else if (
      target.hash &&
      !page.data.anchors.includes(decodeURIComponent(target.hash.slice(1)))
    ) {
      issues.push(`${location}: missing anchor ${url}`);
    }
  }

  for (const page of pages) {
    for (const link of page.data.links) {
      checkLink(link.url, page.url, `${page.path}:${link.line}`, link.asset);
    }
  }
  for (const file of documentation.files) {
    if (file.type !== "meta") continue;
    const references = [
      ...(file.data.pages ?? []),
      ...(file.data.pagesIndex ? [file.data.pagesIndex] : []),
    ];
    for (const entry of references) {
      if (entry.startsWith("---") || entry === "..." || entry === "z...a")
        continue;
      const link = entry.match(/\]\(([^)]+)\)$/);
      if (link?.[1]) {
        checkLink(link[1], "/docs/", file.path);
        continue;
      }
      const relativePath = entry.replace(/^!|^\.\.\./, "");
      const path = resolve(dirname(file.absolutePath!), relativePath);
      if (![path, `${path}.mdx`, `${path}.md`].some(existsSync)) {
        issues.push(`${file.path}: missing navigation target ${entry}`);
      }
    }
  }
  return issues;
}

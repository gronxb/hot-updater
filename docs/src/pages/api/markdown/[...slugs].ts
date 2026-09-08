import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

const prefix = "/api/markdown/";

const getPageSlugs = (request: Request) => {
  const { pathname } = new URL(request.url);
  const path = decodeURIComponent(pathname.slice(prefix.length));
  const markdownPath = path.replace(/\.mdx?$/, "");

  if (markdownPath === "index") return [];
  return markdownPath.split("/").filter(Boolean);
};

export async function GET(request: Request) {
  const slugs = getPageSlugs(request);
  const page =
    source.getPage(slugs) ??
    (slugs.at(-1) === "index" ? source.getPage(slugs.slice(0, -1)) : undefined);

  if (!page) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export async function getConfig() {
  const pages = source.getPages().flatMap((page) => {
    const slugs = page.slugs.length > 0 ? page.slugs : ["index"];
    const last = slugs.at(-1)!;

    const canonical = [...slugs.slice(0, -1), `${last}.md`];
    const filename = page.path
      .replace(/\.mdx?$/, ".md")
      .split("/")
      .filter((segment) => !/^\(.+\)$/.test(segment));
    return canonical.join("/") === filename.join("/")
      ? [canonical]
      : [canonical, filename];
  });

  return {
    render: "static" as const,
    staticPaths: pages,
  } as const;
}

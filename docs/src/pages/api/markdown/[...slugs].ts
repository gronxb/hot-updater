import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

const prefix = "/api/markdown/";

const getPageSlugs = (request: Request) => {
  const { pathname } = new URL(request.url);
  const path = decodeURIComponent(pathname.slice(prefix.length));
  const markdownPath = path.endsWith(".mdx") ? path.slice(0, -4) : path;

  if (markdownPath === "index") return [];
  return markdownPath.split("/").filter(Boolean);
};

export async function GET(request: Request) {
  const page = source.getPage(getPageSlugs(request));

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
  const pages = source.getPages().map((page) => {
    const slugs = page.slugs.length > 0 ? page.slugs : ["index"];
    const last = slugs.at(-1)!;

    return [...slugs.slice(0, -1), `${last}.mdx`];
  });

  return {
    render: "static" as const,
    staticPaths: pages,
  } as const;
}

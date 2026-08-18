import defaultMdxComponents from "fumadocs-ui/mdx";
import { ArrowLeft } from "lucide-react";
import type { ComponentProps } from "react";
import type { PageProps } from "waku/router";

import { blog, formatBlogDate } from "@/lib/blog";

export default function BlogPost({ slug }: PageProps<"/blog/[slug]">) {
  const page = blog.getPage([slug]);

  if (!page) {
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-24 text-center md:px-8">
        <h1 className="text-3xl font-semibold">Post not found</h1>
        <a className="mt-6 inline-block text-fd-primary" href="/blog">
          Return to the blog
        </a>
      </div>
    );
  }

  const MDX = page.data.body;
  const components = defaultMdxComponents as ComponentProps<
    typeof MDX
  >["components"];

  return (
    <article className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 md:px-8 md:pb-32 md:pt-16">
      <title>{`${page.data.title} · Hot Updater`}</title>
      <meta name="description" content={page.data.description} />

      <a
        href="/blog"
        className="mb-16 inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        All posts
      </a>

      <header className="border-b border-fd-border pb-12 md:pb-16">
        <div className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-xs uppercase tracking-[0.13em] text-fd-muted-foreground">
          <time dateTime={page.data.date}>
            {formatBlogDate(page.data.date)}
          </time>
          <span aria-hidden="true" className="text-fd-primary">
            /
          </span>
          <span>{page.data.author}</span>
        </div>
        <h1 className="text-balance text-4xl font-semibold tracking-[-0.04em] text-fd-foreground sm:text-6xl md:text-7xl">
          {page.data.title}
        </h1>
        <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground md:text-xl">
          {page.data.description}
        </p>
      </header>

      <div className="prose mt-12 max-w-none md:mt-16">
        <MDX components={components} />
      </div>
    </article>
  );
}

export const getConfig = async () => ({
  render: "static" as const,
  staticPaths: blog
    .getPages()
    .map((page) => page.slugs[0])
    .filter((slug): slug is string => Boolean(slug)),
});

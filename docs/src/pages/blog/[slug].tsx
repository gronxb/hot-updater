import { InlineTOC } from "fumadocs-ui/components/inline-toc";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { ArrowLeft } from "lucide-react";
import type { ComponentProps } from "react";
import type { PageProps } from "waku/router";

import { blog, formatBlogDate } from "@/lib/blog";
import { blogAuthors } from "@/lib/blog-authors";

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

  const author = blogAuthors[page.data.author];
  const MDX = page.data.body;
  const components = defaultMdxComponents as ComponentProps<
    typeof MDX
  >["components"];

  return (
    <article className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 md:px-8 md:pb-32 md:pt-16">
      <title>{`${page.data.title} · Hot Updater`}</title>
      <meta name="description" content={page.data.description} />
      <meta name="author" content={author.name} />

      <a
        href="/blog"
        className="mb-16 inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.14em] text-fd-muted-foreground transition-colors hover:text-fd-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        All posts
      </a>

      <header className="border-b border-fd-border pb-12 md:pb-14">
        <dl className="mb-8 flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <dt className="font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground">
              Written by
            </dt>
            <dd className="mt-1">
              <a
                href={author.githubUrl}
                rel="author"
                aria-label={`View ${author.name}'s GitHub profile`}
                className="group inline-flex min-h-11 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-primary focus-visible:ring-offset-4 focus-visible:ring-offset-fd-background"
              >
                <img
                  src={author.avatarUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 rounded-full border border-fd-border object-cover"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-fd-foreground group-hover:text-fd-primary">
                    {author.name}
                  </span>
                  <span className="text-xs text-fd-muted-foreground">
                    GitHub profile
                  </span>
                </span>
              </a>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground">
              Published
            </dt>
            <dd className="mt-1 flex min-h-11 items-center text-sm font-medium text-fd-foreground">
              <time dateTime={page.data.date}>
                {formatBlogDate(page.data.date)}
              </time>
            </dd>
          </div>
        </dl>
        <h1 className="text-balance text-4xl font-semibold tracking-[-0.04em] text-fd-foreground sm:text-6xl md:text-7xl">
          {page.data.title}
        </h1>
        <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground md:text-xl">
          {page.data.description}
        </p>
      </header>

      <InlineTOC items={page.data.toc} className="mt-10" />

      <div className="prose mt-12 max-w-none md:mt-14">
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

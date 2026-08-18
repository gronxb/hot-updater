import { ArrowUpRight } from "lucide-react";

import { formatBlogDate, getBlogPosts } from "@/lib/blog";

export default function BlogIndex() {
  const posts = getBlogPosts();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-24 pt-16 md:px-8 md:pt-24">
      <title>Blog · Hot Updater</title>
      <meta
        name="description"
        content="Release notes and engineering stories from Hot Updater."
      />

      <header className="grid gap-10 border-b border-fd-border pb-14 md:grid-cols-[1fr_auto] md:items-end md:pb-20">
        <div>
          <p className="mb-5 font-mono text-xs font-medium uppercase tracking-[0.22em] text-fd-primary">
            Hot Updater Journal
          </p>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-[-0.045em] text-fd-foreground sm:text-7xl md:text-8xl">
            Built in the open.
          </h1>
        </div>
        <p className="max-w-sm text-pretty text-base leading-7 text-fd-muted-foreground md:pb-2">
          Release notes, architecture decisions, and the work behind reliable
          over-the-air updates.
        </p>
      </header>

      <section aria-labelledby="latest-posts" className="pt-10 md:pt-14">
        <div className="mb-7 flex items-center justify-between gap-4">
          <h2
            id="latest-posts"
            className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-fd-muted-foreground"
          >
            Latest writing
          </h2>
          <span className="font-mono text-xs text-fd-muted-foreground">
            {String(posts.length).padStart(2, "0")}
          </span>
        </div>

        <div className="divide-y divide-fd-border border-y border-fd-border">
          {posts.map((post, index) => (
            <a
              key={post.url}
              href={post.url}
              className="group grid gap-6 py-9 transition-colors hover:bg-fd-card/45 sm:grid-cols-[4.5rem_1fr_auto] sm:items-center sm:px-5 sm:py-11"
            >
              <span className="font-mono text-xs text-fd-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <span className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground">
                  <time dateTime={post.data.date}>
                    {formatBlogDate(post.data.date)}
                  </time>
                  <span aria-hidden="true">/</span>
                  <span>{post.data.author}</span>
                </span>
                <span className="block text-2xl font-semibold tracking-[-0.025em] text-fd-foreground sm:text-3xl">
                  {post.data.title}
                </span>
                <span className="mt-3 block max-w-2xl text-base leading-7 text-fd-muted-foreground">
                  {post.data.description}
                </span>
              </span>
              <span className="flex size-11 items-center justify-center rounded-full border border-fd-border text-fd-muted-foreground transition-all group-hover:border-fd-primary group-hover:bg-fd-primary group-hover:text-fd-primary-foreground">
                <ArrowUpRight aria-hidden="true" className="size-4" />
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

export const getConfig = async () => ({
  render: "static" as const,
});

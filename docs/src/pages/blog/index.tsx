import { ArrowRight } from "lucide-react";

import { formatBlogDate, getBlogPosts } from "@/lib/blog";

export default function BlogIndex() {
  const posts = getBlogPosts();
  const [featuredPost, ...morePosts] = posts;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 pb-24 pt-12 md:px-8 md:pt-16">
      <title>Blog · Hot Updater</title>
      <meta
        name="description"
        content="Release notes and engineering stories from Hot Updater."
      />

      <header className="border-b border-fd-border pb-10 md:pb-12">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-fd-foreground sm:text-4xl">
          Hot Updater Blog
        </h1>
        <p className="mt-3 max-w-2xl text-pretty text-base leading-7 text-fd-muted-foreground">
          Release notes and engineering stories about building reliable
          over-the-air updates.
        </p>
      </header>

      <section aria-labelledby="featured-post" className="pt-8 md:pt-10">
        {featuredPost ? (
          <a
            href={featuredPost.url}
            className="group grid overflow-hidden rounded-xl border border-fd-border bg-fd-card transition-colors hover:border-fd-primary/50 lg:grid-cols-[minmax(0,0.88fr)_minmax(28rem,1.12fr)]"
          >
            <div className="flex flex-col justify-between gap-12 p-7 sm:p-10 lg:p-12">
              <div>
                <div className="mb-7 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground">
                  <span className="text-fd-primary">Featured</span>
                  <span aria-hidden="true">/</span>
                  <time dateTime={featuredPost.data.date}>
                    {formatBlogDate(featuredPost.data.date)}
                  </time>
                </div>
                <h2
                  id="featured-post"
                  className="max-w-2xl text-balance text-4xl font-semibold tracking-[-0.04em] text-fd-foreground sm:text-5xl lg:text-6xl"
                >
                  {featuredPost.data.title}
                </h2>
                <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-fd-muted-foreground sm:text-lg sm:leading-8">
                  {featuredPost.data.description}
                </p>
              </div>

              <span className="inline-flex items-center gap-2 text-sm font-medium text-fd-foreground">
                Read the story
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
                />
              </span>
            </div>

            {featuredPost.data.image ? (
              <div className="order-first overflow-hidden border-b border-fd-border bg-neutral-950 lg:order-last lg:border-b-0 lg:border-l">
                <img
                  alt=""
                  src={featuredPost.data.image}
                  width={1672}
                  height={941}
                  fetchPriority="high"
                  className="h-full min-h-64 w-full object-cover transition-transform duration-500 group-hover:scale-[1.015] motion-reduce:transform-none lg:min-h-[34rem]"
                />
              </div>
            ) : null}
          </a>
        ) : (
          <div className="rounded-xl border border-fd-border bg-fd-card p-8 sm:p-10">
            <h2
              id="featured-post"
              className="text-2xl font-semibold tracking-[-0.025em] text-fd-foreground"
            >
              No posts yet
            </h2>
            <p className="mt-3 max-w-xl leading-7 text-fd-muted-foreground">
              Engineering notes are on the way. Until then, explore how Hot
              Updater works in the documentation.
            </p>
            <a
              href="/docs/get-started/introduction"
              className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-fd-foreground hover:text-fd-primary"
            >
              Read the documentation
              <ArrowRight aria-hidden="true" className="size-4" />
            </a>
          </div>
        )}
      </section>

      {morePosts.length > 0 ? (
        <section aria-labelledby="more-posts" className="pt-14 md:pt-16">
          <h2
            id="more-posts"
            className="mb-6 font-mono text-xs font-medium uppercase tracking-[0.16em] text-fd-muted-foreground"
          >
            More stories
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {morePosts.map((post) => (
              <a
                key={post.url}
                href={post.url}
                className="group flex min-h-64 flex-col justify-between rounded-xl border border-fd-border bg-fd-card p-7 transition-colors hover:border-fd-primary/50"
              >
                <div>
                  <time
                    dateTime={post.data.date}
                    className="font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground"
                  >
                    {formatBlogDate(post.data.date)}
                  </time>
                  <h3 className="mt-5 text-2xl font-semibold tracking-[-0.025em] text-fd-foreground">
                    {post.data.title}
                  </h3>
                  <p className="mt-3 leading-7 text-fd-muted-foreground">
                    {post.data.description}
                  </p>
                </div>
                <ArrowRight
                  aria-hidden="true"
                  className="mt-8 size-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

export const getConfig = async () => ({
  render: "static" as const,
});

import { loader, type PageData } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import type { DocData, DocMethods } from "fumadocs-mdx/runtime/types";

import { blogPosts } from "../../.source/server";

type BlogPostData = PageData &
  DocData &
  DocMethods & {
    author: string;
    date: string;
    image?: string;
  };

export const blog = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts as BlogPostData[], []),
});

export const getBlogPosts = () =>
  [...blog.getPages()].sort((left, right) =>
    right.data.date.localeCompare(left.data.date),
  );

export const formatBlogDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));

import defaultMdxComponents from "fumadocs-ui/mdx";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import type { ComponentProps } from "react";
import type { PageProps } from "waku/router";

import { VersionTag } from "@/components/version-tag";
import { source } from "@/lib/source";

const githubBaseUrl =
  "https://github.com/gronxb/hot-updater/blob/main/docs/content/docs";

const getMarkdownUrl = (slugs: string[]) => {
  const segments = slugs.length > 0 ? slugs : ["index"];
  const last = segments.at(-1)!;

  return `/api/markdown/${[...segments.slice(0, -1), `${last}.mdx`].join("/")}`;
};

export default function DocPage({ slugs }: PageProps<"/docs/[...slugs]">) {
  const page = source.getPage(slugs);

  if (!page) {
    return (
      <div className="text-center py-12">
        <h1 className="text-3xl font-bold mb-4 text-gray-900 dark:text-gray-100">
          Page Not Found
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          The page you are looking for does not exist.
        </p>
      </div>
    );
  }

  const MDX = page.data.body;
  const components = defaultMdxComponents as ComponentProps<
    typeof MDX
  >["components"];
  const markdownUrl = getMarkdownUrl(page.slugs);
  const githubUrl = `${githubBaseUrl}/${page.path}`;

  return (
    <DocsPage toc={page.data.toc}>
      <div className="flex flex-row items-center gap-2 border-b pt-2 pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover githubUrl={githubUrl} markdownUrl={markdownUrl} />
      </div>
      <DocsTitle>{page.data.title}</DocsTitle>
      <VersionTag version={page.data?.version} />
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={components} />
      </DocsBody>
    </DocsPage>
  );
}

export async function getConfig() {
  const pages = source
    .generateParams()
    .map((item) => (item.lang ? [item.lang, ...item.slug] : item.slug));

  return {
    render: "static" as const,
    staticPaths: pages,
  } as const;
}

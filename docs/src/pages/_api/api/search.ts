import type { StructuredData } from "fumadocs-core/mdx-plugins";
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

export const { staticGET: GET } = createFromSource(source, {
  async buildIndex(page) {
    const sourceData = page.data.structuredData;
    const structuredData = (
      typeof sourceData === "function" ? await sourceData() : sourceData
    ) as StructuredData | undefined;

    if (!structuredData) {
      throw new Error(`Cannot index documentation page: ${page.path}`);
    }

    return {
      title: page.data.title ?? page.path,
      description: page.data.description,
      url: page.url,
      id: page.url,
      structuredData,
      tag: page.slugs[0] === "v0" ? "v0" : "latest",
    };
  },
});

export const getConfig = async () => {
  return {
    render: "static" as const,
  };
};

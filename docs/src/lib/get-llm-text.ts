import type { InferPageType } from "fumadocs-core/source";

import type { source } from "@/lib/source";

import { parseDocument } from "../../plugins/docs-content";

export async function getLLMText(page: {
  url: string;
  data: Pick<
    InferPageType<typeof source>["data"],
    "title" | "description" | "getText"
  >;
}) {
  const { markdown } = parseDocument(await page.data.getText("raw"));
  const description = page.data.description
    ? `\n\n> ${page.data.description}`
    : "";
  return `# ${page.data.title} (https://hot-updater.dev${page.url})${description}\n\n${markdown}`;
}

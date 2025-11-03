import { defineDocs, defineCollections } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineCollections({
  docs,
});

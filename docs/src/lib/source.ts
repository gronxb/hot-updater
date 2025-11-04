import { loader as createLoader } from "fumadocs-core/source";
import { create, docs } from "@/.source";

export const source = createLoader({
  source: await create.sourceAsync(docs.doc, docs.meta),
  baseUrl: "/docs",
});

export const loader = source;

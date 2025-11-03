import { createAPIFileRoute } from "@tanstack/start/api";
import { createSearchAPI } from "fumadocs-core/search/server";
import { loader } from "~/lib/source";

export const Route = createAPIFileRoute("/api/search")({
  GET: ({ request }) => {
    return createSearchAPI("advanced", {
      indexes: loader.getPages().map((page) => ({
        title: page.data.title,
        description: page.data.description,
        structuredData: page.data.structuredData,
        id: page.url,
        url: page.url,
      })),
    })(request);
  },
});

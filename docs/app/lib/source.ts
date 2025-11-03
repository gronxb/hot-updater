import { docs } from "~/source.config";
import { createClientLoader } from "fumadocs-core/loader";

export const loader = createClientLoader({
  baseUrl: "/docs",
  source: docs,
});

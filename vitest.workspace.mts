import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*",
  "plugins/*",
  "examples/hono-server",
  "examples/elysia-server",
]);

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
    {
      find: new RegExp("^@hot-updater/android-helper$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/android-helper/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/android-helper/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/android-helper/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/apple-helper$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/apple-helper/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/apple-helper/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/apple-helper/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/bsdiff$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/bsdiff/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/bsdiff/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/bsdiff/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/cli-tools$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/cli-tools/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/cli-tools/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/cli-tools/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/core$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/core/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/core/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/core/src/$1",
    },
    {
      find: new RegExp("^hot-updater$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/hot-updater/src/index.ts",
    },
    {
      find: new RegExp("^hot-updater/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/hot-updater/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/react-native$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/react-native/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/react-native/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/react-native/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/server$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/server/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/server/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/server/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/test-utils$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/test-utils/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/test-utils/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/packages/test-utils/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/aws$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/aws/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/aws/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/aws/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/bare$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/bare/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/bare/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/bare/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/cloudflare$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/cloudflare/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/cloudflare/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/cloudflare/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/datadog-plugin$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/datadog-plugin/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/datadog-plugin/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/datadog-plugin/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/expo$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/expo/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/expo/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/expo/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/firebase$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/firebase/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/firebase/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/firebase/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/js$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/js/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/js/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/js/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/mock$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/mock/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/mock/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/mock/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/plugin-core$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/plugin-core/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/plugin-core/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/plugin-core/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/postgres$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/postgres/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/postgres/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/postgres/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/rock$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/rock/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/rock/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/rock/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/sentry-plugin$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/sentry-plugin/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/sentry-plugin/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/sentry-plugin/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/standalone$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/standalone/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/standalone/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/standalone/src/$1",
    },
    {
      find: new RegExp("^@hot-updater/supabase$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/supabase/src/index.ts",
    },
    {
      find: new RegExp("^@hot-updater/supabase/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/plugins/supabase/src/$1",
    },
    {
      find: new RegExp("^@examples-server/elysia-drizzle-libsql$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/elysia-drizzle-libsql/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/elysia-drizzle-libsql/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/elysia-drizzle-libsql/src/$1",
    },
    {
      find: new RegExp("^@examples-server/express-prisma-sqlite$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/express-prisma-sqlite/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/express-prisma-sqlite/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/express-prisma-sqlite/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-drizzle-pglite$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-drizzle-pglite/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-drizzle-pglite/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-drizzle-pglite/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-dynamodb$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-dynamodb/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-dynamodb/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-dynamodb/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-kysely-mysql$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-kysely-mysql/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-kysely-mysql/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-kysely-mysql/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-kysely-pglite$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-kysely-pglite/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-kysely-pglite/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-kysely-pglite/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-mongodb$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-mongodb/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-mongodb/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-mongodb/src/$1",
    },
    {
      find: new RegExp("^@examples-server/hono-prisma-postgres$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-prisma-postgres/src/index.ts",
    },
    {
      find: new RegExp("^@examples-server/hono-prisma-postgres/(.*)$"),
      replacement: "/Users/gronxb/workspace/hot-updater2/examples-server/hono-prisma-postgres/src/$1",
    }
    ],
  },
  test: {
    environment: "node",
  },
});

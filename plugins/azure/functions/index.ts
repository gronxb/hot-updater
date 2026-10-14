import { app, type HttpRequest } from "@azure/functions";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

import { azureBlobStorage } from "../src/azureBlobStorage";
import { cosmosDatabase } from "../src/cosmosDatabase";

/** The Function App settings init sets. */
const requireSetting = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set on the Function App. Run \`hot-updater init\` again to configure it.`,
    );
  }
  return value;
};

const hotUpdater = createHotUpdater({
  database: cosmosDatabase({
    connectionString: requireSetting(
      "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
    ),
  }),
  plugins: [insights(), apiKeys(), remoteConfig()],
  storage: azureBlobStorage({
    connectionString: requireSetting(
      "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
    ),
    containerName: requireSetting("HOT_UPDATER_AZURE_BLOB_CONTAINER"),
  }),
});

// Bodies stream through as they are: a route may answer with binary data,
// such as a storage object the server serves itself.
app.setup({ enableHttpStream: true });

/** Every path reaches the client handler; `host.json` drops the `/api` prefix. */
app.http("hot-updater", {
  route: "{*path}",
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request: HttpRequest) => {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await hotUpdater.handlers.client(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      }),
    );
    return {
      status: response.status,
      headers: response.headers,
      body: response.body ?? undefined,
    };
  },
});

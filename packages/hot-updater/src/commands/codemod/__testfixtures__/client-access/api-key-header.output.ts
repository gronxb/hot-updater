import { createHotUpdater } from "@hot-updater/server";
import { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URL!);

export const hotUpdater = createHotUpdater({
  database: mongoAdapter({ client }),
  plugins: [insights(), apiKeys({ headerName: "x-hot-updater-key" })],
});

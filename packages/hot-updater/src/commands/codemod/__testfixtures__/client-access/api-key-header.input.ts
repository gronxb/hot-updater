import { createHotUpdater } from "@hot-updater/server";
import { mongoAdapter } from "@hot-updater/server/adapters/mongodb";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URL!);

export const hotUpdater = createHotUpdater({
  database: mongoAdapter({ client }),
  clientAccess: {
    type: "api-key",
    headerName: "x-hot-updater-key",
  },
});

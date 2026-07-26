import { appendFile } from "node:fs/promises";

const markerPath = process.env.HOT_UPDATER_PATCH_LIFECYCLE_MARKER;

const mark = async (value) => {
  if (markerPath === undefined) {
    throw new Error("HOT_UPDATER_PATCH_LIFECYCLE_MARKER is required");
  }
  await appendFile(markerPath, `${value}\n`, "utf8");
};

const unsupportedDatabaseOperation = async () => {
  throw new Error("The patch lifecycle fixture must fail before database I/O");
};

export default {
  storage: () => ({
    name: "patch-lifecycle-storage",
    supportedProtocol: "patch-lifecycle",
    profiles: {
      node: {
        upload: async () => {
          throw new Error("Unexpected upload");
        },
        exists: async () => false,
        getDownloadUrl: async () => {
          throw new Error("Unexpected download");
        },
      },
    },
    onUnmount: async () => mark("storage-disposed"),
  }),
  database: {
    name: "patch-lifecycle-database",
    create: unsupportedDatabaseOperation,
    update: unsupportedDatabaseOperation,
    delete: unsupportedDatabaseOperation,
    count: unsupportedDatabaseOperation,
    findOne: unsupportedDatabaseOperation,
    findMany: unsupportedDatabaseOperation,
    onUnmount: async () => mark("database-disposed"),
  },
};

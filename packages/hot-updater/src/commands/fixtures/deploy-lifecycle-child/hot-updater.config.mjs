import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const markerPath = process.env["HOT_UPDATER_DEPLOY_LIFECYCLE_MARKER"] ?? "";
const workingDirectory =
  process.env["HOT_UPDATER_DEPLOY_LIFECYCLE_WORKDIR"] ?? "";
const mode = process.env["HOT_UPDATER_DEPLOY_LIFECYCLE_MODE"] ?? "success";
const rows = {
  bundle_events: [],
  bundle_patches: [],
  bundles: [],
};
const storage = {
  name: "deploy-lifecycle-child-storage",
  supportedProtocol: "fixture",
  profiles: {
    node: {
      async delete() {},
      async downloadFile() {},
      async exists() {
        return false;
      },
      async upload(key) {
        return {
          storageUri: `fixture://deploy-lifecycle/${key}/bundle.zip`,
        };
      },
    },
  },
  async onUnmount() {
    await appendFile(markerPath, "storage-disposed\n");
  },
};
const database = {
  name: "deploy-lifecycle-child-database",
  async count({ model }) {
    return rows[model].length;
  },
  async create({ data, model }) {
    rows[model].push(data);
    return data;
  },
  async delete() {},
  async findMany({ model }) {
    return rows[model];
  },
  async findOne({ model }) {
    return rows[model][0] ?? null;
  },
  async update({ model, update }) {
    const row = rows[model][0];
    if (row === undefined) {
      return null;
    }
    Object.assign(row, update);
    return row;
  },
};

export default {
  build: () => ({
    name: "deploy-lifecycle-child-build",
    async build() {
      if (mode === "failure") {
        throw new Error("deploy lifecycle child build failure");
      }
      const buildPath = path.join(workingDirectory, "bundle");
      await mkdir(buildPath, { recursive: true });
      await writeFile(path.join(buildPath, "index.bundle"), "fixture");
      return {
        buildPath,
        bundleId: "deploy-lifecycle-child-bundle",
        stdout: null,
      };
    },
  }),
  compressStrategy: "zip",
  database,
  patch: { enabled: false },
  storage,
  updateStrategy: "appVersion",
};

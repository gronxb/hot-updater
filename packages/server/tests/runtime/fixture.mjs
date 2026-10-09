// The server bundle with `plugins: []` and a storage adapter that no route here reads.
import { createHotUpdater } from "../../dist/index.mjs";

const unused = () => {
  throw new Error("The runtime fixture reads no rows or objects.");
};

export const hotUpdater = createHotUpdater({
  database: {
    name: "runtime-fixture",
    adapter: { fits: () => true, get: unused, query: unused, write: unused },
  },
  storage: {
    name: "runtime-fixture",
    protocol: "runtime-fixture",
    get: unused,
    getDownloadUrl: unused,
  },
  plugins: [],
  clientAccess: "public",
});

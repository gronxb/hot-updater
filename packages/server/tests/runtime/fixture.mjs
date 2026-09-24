// The server bundle with `plugins: []` and a storage adapter that no route here reads.
import { createHotUpdater } from "../../dist/index.mjs";

const unused = () => {
  throw new Error("The runtime fixture reads no rows.");
};

export const hotUpdater = createHotUpdater({
  database: {
    name: "runtime-fixture",
    adapter: { fits: () => true, get: unused, query: unused, write: unused },
  },
  plugins: [],
  clientAccess: "public",
});

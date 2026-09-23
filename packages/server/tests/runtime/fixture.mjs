// The server bundle with `plugins: []` and a database stub that no route here reads.
import { createHotUpdater } from "../../dist/index.mjs";

const unused = () => {
  throw new Error("The runtime fixture reads no rows.");
};
const methods = new Proxy({}, { get: () => unused, has: () => true });

export const hotUpdater = createHotUpdater({
  database: {
    name: "runtime-fixture",
    models: new Proxy({}, { get: () => methods, has: () => true }),
    commit: unused,
  },
  plugins: [],
  clientAccess: "public",
});

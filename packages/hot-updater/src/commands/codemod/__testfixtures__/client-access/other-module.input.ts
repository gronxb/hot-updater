import { createHotUpdater } from "./legacy/createHotUpdater";

// A local helper that shares the name; its options are not the server's.
export const hotUpdater = createHotUpdater({
  clientAccess: { type: "public" },
});

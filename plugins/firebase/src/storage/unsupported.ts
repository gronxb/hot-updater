import { StoragePluginError } from "@hot-updater/plugin-core/storage";

export const firebaseStorage = (): never => {
  throw new StoragePluginError(
    "unsupported",
    "Firebase Storage requires the Node conditional export or the explicit functions entry.",
  );
};

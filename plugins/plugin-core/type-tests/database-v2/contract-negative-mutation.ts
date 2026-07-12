import type { BundleChangeV2 } from "@hot-updater/plugin-core/database-v2";

const change: BundleChangeV2 = {
  type: "delete",
  id: "bundle-id",
  precondition: { state: "absent" },
};

void change;

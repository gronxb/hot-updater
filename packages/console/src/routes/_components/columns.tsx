import type { UpdateSource } from "@hot-updater/core";
import {
  type AccessorKeyColumnDef,
  createColumnHelper,
} from "@tanstack/solid-table";
import { Check, X } from "lucide-solid";

const columnHelper = createColumnHelper<UpdateSource>();

const formatDateTimeFromBundleVersion = (input: string): string => {
  const year = input.substring(0, 4);
  const month = input.substring(4, 6);
  const day = input.substring(6, 8);
  const hour = input.substring(8, 10);
  const minute = input.substring(10, 12);
  const second = input.substring(12, 14);

  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
};

export const columns: AccessorKeyColumnDef<UpdateSource, any>[] = [
  columnHelper.accessor("platform", {
    header: "Platform",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("targetVersion", {
    header: "Target Version",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("enabled", {
    header: "Enabled",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center gap-2">
          <Check />
          <p>Enabled</p>
        </div>
      ) : (
        <div class="flex flex-row items-center gap-2">
          <X />
          <p>Disabled</p>
        </div>
      ),
  }),
  columnHelper.accessor("description", {
    header: "Description",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("bundleVersion", {
    header: "Created At",
    cell: (info) => formatDateTimeFromBundleVersion(String(info.getValue())),
  }),
];

import type { UpdateSource } from "@hot-updater/utils";
import type { ColumnDef } from "@tanstack/solid-table";
import { Check, X } from "lucide-solid";

const formatDateTimeFromBundleVersion = (input: string): string => {
  const year = input.substring(0, 4);
  const month = input.substring(4, 6);
  const day = input.substring(6, 8);
  const hour = input.substring(8, 10);
  const minute = input.substring(10, 12);
  const second = input.substring(12, 14);

  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
};

export const columns: ColumnDef<UpdateSource>[] = [
  {
    accessorKey: "platform",
    header: "Platform",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "targetVersion",
    header: "Target Version",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "enabled",
    header: "Enabled",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <Check />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <X />
        </div>
      ),
  },
  {
    accessorKey: "forceUpdate",
    header: "Force Update",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <Check />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <X />
        </div>
      ),
  },
  {
    accessorKey: "description",
    header: "Description",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "bundleTimestamp",
    header: "Created At",
    cell: (info) => formatDateTimeFromBundleVersion(String(info.getValue())),
  },
];

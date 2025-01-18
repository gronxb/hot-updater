import { extractTimestampFromUUIDv7 } from "@/lib/extract-timestamp-from-uuidv7";
import type { Bundle } from "@hot-updater/core";
import type { ColumnDef } from "@tanstack/solid-table";
import dayjs from "dayjs";
import { Check, X } from "lucide-solid";

export const columns: ColumnDef<Bundle>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "platform",
    header: "Platform",
    cell: (info) => {
      switch (info.getValue()) {
        case "ios":
          return "iOS";
        case "android":
          return "Android";
      }
    },
  },
  {
    accessorKey: "targetAppVersion",
    header: "Target App Version",
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
    accessorKey: "shouldForceUpdate",
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
    accessorKey: "message",
    header: "Message",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "id",
    header: "Created At",
    cell: (info) =>
      dayjs(extractTimestampFromUUIDv7(String(info.getValue()))).format(
        "YYYY-MM-DD HH:mm:ss",
      ),
  },
];

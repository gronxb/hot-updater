import { AiFillAndroid, AiFillApple } from "solid-icons/ai";

import { extractTimestampFromUUIDv7 } from "@/lib/extract-timestamp-from-uuidv7";
import type { Bundle } from "@hot-updater/core";
import type { ColumnDef } from "@tanstack/solid-table";
import dayjs from "dayjs";
import { Check, Fingerprint, Package, X } from "lucide-solid";

export const columns: ColumnDef<Bundle>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "channel",
    header: "Channel",
    cell: (info) => info.getValue(),
  },
  {
    accessorKey: "platform",
    header: "Platform",
    cell: (info) => {
      switch (info.getValue()) {
        case "ios":
          return (
            <div class="flex flex-row items-center">
              <AiFillApple class="mr-2" size={16} />
              iOS
            </div>
          );
        case "android":
          return (
            <div class="flex flex-row items-center">
              <AiFillAndroid class="mr-2" size={16} color="#3DDC84" />
              Android
            </div>
          );
      }
    },
  },
  {
    header: "Target",
    cell: (info) => {
      if (info.row.original.targetAppVersion) {
        return (
          <div class="flex flex-row items-center">
            <Package class="mr-2" size={16} />
            {info.row.original.targetAppVersion}
          </div>
        );
      }
      if (info.row.original.fingerprintHash) {
        return (
          <div class="flex flex-row items-center">
            <Fingerprint class="mr-2" size={16} />
            {info.row.original.fingerprintHash}
          </div>
        );
      }
      return "N/A";
    },
  },
  {
    accessorKey: "enabled",
    header: "Enabled",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <Check class="text-green-500" />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <X class="text-red-500" />
        </div>
      ),
  },
  {
    accessorKey: "shouldForceUpdate",
    header: "Force Update",
    cell: (info) =>
      info.getValue() ? (
        <div class="flex flex-row items-center">
          <Check class="text-green-500" />
        </div>
      ) : (
        <div class="flex flex-row items-center">
          <X class="text-red-500" />
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

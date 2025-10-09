import type { Bundle } from "@hot-updater/core";
import type { ColumnDef } from "@tanstack/solid-table";
import dayjs from "dayjs";
import { Check, Fingerprint, Package, X } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { Show } from "solid-js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractTimestampFromUUIDv7 } from "@/lib/extract-timestamp-from-uuidv7";

export const columns: ColumnDef<Bundle>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: (info) => {
      return (
        <Tooltip openDelay={0} closeDelay={0}>
          <TooltipTrigger>{info.row.original.id.slice(-12)}</TooltipTrigger>
          <TooltipContent>
            <p>{info.row.original.id}</p>
          </TooltipContent>
        </Tooltip>
      );
    },
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
          <Tooltip openDelay={0} closeDelay={0}>
            <TooltipTrigger class="flex flex-row items-center">
              <Fingerprint class="mr-2" size={16} />
              {info.row.original.fingerprintHash.slice(0, 8)}

              <Show when={info.row.original.metadata?.app_version}>
                <span class="ml-2 text-muted-foreground">
                  ({info.row.original.metadata?.app_version})
                </span>
              </Show>
            </TooltipTrigger>
            <TooltipContent>
              <p>{info.row.original.fingerprintHash}</p>
            </TooltipContent>
          </Tooltip>
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

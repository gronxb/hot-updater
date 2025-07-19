import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNativeBuildDownloadUrlQuery } from "@/lib/api";
import { extractDateFromUUIDv7 } from "@/lib/utils";
import type { ColumnDef } from "@tanstack/solid-table";
import { Download, Eye, Fingerprint, Package2 } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { createMemo } from "solid-js";

export interface NativeBuild {
  id: string;
  nativeVersion: string;
  platform: "ios" | "android";
  fingerprintHash: string;
  storageUri: string;
  fileHash: string;
  fileSize: number;
  channel: string;
  metadata?: Record<string, any>;
}

export const createNativeBuildsColumns = (
  onRowDetailClick?: (build: NativeBuild) => void,
): ColumnDef<NativeBuild>[] => [
  {
    accessorKey: "id",
    header: "Min Bundle ID",
    cell: (info) => {
      const minBundleId = info.getValue() as string | undefined;
      return (
        <div class="flex flex-row items-center">
          <Package2 class="mr-2" size={16} />
          {minBundleId ? (
            <Tooltip openDelay={0} closeDelay={0}>
              <TooltipTrigger class="font-mono text-sm">
                {minBundleId}
              </TooltipTrigger>
              <TooltipContent>
                <p class="font-mono text-sm">{minBundleId}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span class="text-muted-foreground text-sm">N/A</span>
          )}
        </div>
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
        default:
          return info.getValue() as string;
      }
    },
  },
  {
    accessorKey: "fingerprintHash",
    header: "Fingerprint Hash",
    cell: (info) => {
      return (
        <Tooltip openDelay={0} closeDelay={0}>
          <TooltipTrigger class="flex flex-row items-center">
            <Fingerprint class="mr-2" size={16} />
            {info.row.original.fingerprintHash.slice(0, 8)}
          </TooltipTrigger>
          <TooltipContent>
            <p class="font-mono text-sm">{info.row.original.fingerprintHash}</p>
          </TooltipContent>
        </Tooltip>
      );
    },
  },

  {
    accessorKey: "downloadUrl",
    header: "Download",
    cell: (info) => {
      const row = info.row.original;
      const downloadUrlQuery = useNativeBuildDownloadUrlQuery(row.id);

      const downloadUrl = createMemo(() => {
        const data = downloadUrlQuery.data;
        if (data && "fileUrl" in data) {
          return data.fileUrl;
        }
        return undefined;
      });

      const handleDownload = () => {
        const url = downloadUrl();
        if (url) {
          window.open(url, "_blank");
        }
      };

      return (
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownload}
          disabled={downloadUrlQuery.isLoading || !downloadUrl()}
        >
          <Download class="mr-2 h-4 w-4" />
          {downloadUrlQuery.isLoading ? "Generating..." : "Download"}
        </Button>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: (info) => {
      const row = info.row.original;
      const date = extractDateFromUUIDv7(row.id);
      return (
        <div class="text-sm text-muted-foreground">
          {date.toLocaleDateString()} {date.toLocaleTimeString()}
        </div>
      );
    },
  },
  {
    id: "actions",
    header: "Actions",
    cell: (info) => {
      const row = info.row.original;
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation(); // Prevent row click
            onRowDetailClick?.(row);
          }}
        >
          <Eye class="mr-2 h-4 w-4" />
          Go to Detail
        </Button>
      );
    },
  },
];

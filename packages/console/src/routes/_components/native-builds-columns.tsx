import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ColumnDef } from "@tanstack/solid-table";
import { Download, Fingerprint, Package2 } from "lucide-solid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";

export interface NativeBuild {
  id: string;
  nativeVersion: string;
  platform: "ios" | "android";
  fingerprintHash: string;
  minBundleId?: string;
  downloadUrl?: string;
}

export const nativeBuildsColumns: ColumnDef<NativeBuild>[] = [
  {
    accessorKey: "nativeVersion",
    header: "Native Version",
    cell: (info) => (
      <div class="font-medium">
        {info.getValue() as string}
      </div>
    ),
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
      const hash = info.getValue() as string;
      return (
        <Tooltip openDelay={0} closeDelay={0}>
          <TooltipTrigger class="flex flex-row items-center">
            <Fingerprint class="mr-2" size={16} />
            {hash.slice(0, 12)}...
          </TooltipTrigger>
          <TooltipContent>
            <p class="font-mono text-sm">{hash}</p>
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    accessorKey: "minBundleId",
    header: "Min Bundle ID",
    cell: (info) => {
      const minBundleId = info.getValue() as string | undefined;
      return (
        <div class="flex flex-row items-center">
          <Package2 class="mr-2" size={16} />
          {minBundleId ? (
            <Tooltip openDelay={0} closeDelay={0}>
              <TooltipTrigger class="font-mono text-sm">
                {minBundleId.slice(-8)}
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
    accessorKey: "downloadUrl",
    header: "Download",
    cell: (info) => {
      const downloadUrl = info.getValue() as string | undefined;
      const row = info.row.original;
      
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (downloadUrl) {
              window.open(downloadUrl, '_blank');
            } else {
              // Fallback: generate download URL or show not available
              console.log(`Download requested for build ${row.id}`);
            }
          }}
          disabled={!downloadUrl}
        >
          <Download class="mr-2 h-4 w-4" />
          Download
        </Button>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: (info) => {
      const date = info.getValue() as Date;
      return (
        <div class="text-sm text-muted-foreground">
          {date.toLocaleDateString()} {date.toLocaleTimeString()}
        </div>
      );
    },
  },
];
import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { Link } from "@tanstack/react-router";
import { RefreshCw, Smartphone } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useNativeBuildIpaDevicesQuery } from "@/lib/ios-devices-api";
import { maskIosUdid } from "@/lib/native-builds";

import { ShortHash } from "./ShortHash";

/**
 * The devices an ad hoc IPA installs on, read from its signing profile: each
 * by the registry's name when the registry knows it, else as an unknown
 * device, over its UDID's last characters, which copy the whole UDID. Read
 * only: the IPA decides, and a new build is what adds a device.
 */
export function IpaDevicesCard({ build }: { readonly build: NativeBuildRow }) {
  const query = useNativeBuildIpaDevicesQuery(build.id);
  const result = query.data;
  // An App Store export or an enterprise build lists none: no card.
  if (result?.status === "store" || result?.status === "enterprise") {
    return null;
  }
  const devices = result?.status === "listed" ? result.devices : null;
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Devices in this build</h2>
        </CardTitle>
        {devices === null ? null : (
          <span className="text-xs tabular-nums text-muted-foreground">
            {devices.length}
          </span>
        )}
        <Link
          className={buttonVariants({
            className: "ml-auto h-11 sm:h-7",
            size: "sm",
            variant: "ghost",
          })}
          to="/native-builds/devices"
        >
          iOS devices
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <span className="sr-only">Reading this IPA's devices</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : query.isError || result?.status === "unavailable" ? (
          <div className="flex flex-wrap items-center gap-3 p-4 text-xs text-muted-foreground">
            <p className="min-w-0 flex-1">
              The Console couldn't read this IPA's devices from storage.
            </p>
            <Button
              className="h-11 sm:h-7"
              onClick={() => void query.refetch()}
              size="sm"
              variant="outline"
            >
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </div>
        ) : devices?.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            This IPA lists no devices.
          </p>
        ) : (
          <ul aria-label="Devices in this build" className="divide-y">
            {devices?.map((device) => (
              <li
                className="flex min-h-11 min-w-0 items-center gap-3 px-4 py-2 text-sm"
                key={device.udid}
              >
                <Smartphone
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-col items-start">
                  <span
                    className={
                      device.name === null
                        ? "truncate text-muted-foreground"
                        : "truncate"
                    }
                  >
                    {device.name ?? "Unknown device"}
                  </span>
                  <span className="text-muted-foreground">
                    <ShortHash
                      label="UDID"
                      shown={maskIosUdid(device.udid)}
                      value={device.udid}
                    />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

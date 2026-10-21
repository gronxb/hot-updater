import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { AlertTriangle, Download } from "lucide-react";

import { PlatformIcon } from "@/components/PlatformIcon";
import { QrCode } from "@/components/QrCode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useNativeBuildDownloadUrlQuery, useNativeBuildQuery } from "@/lib/api";
import {
  apkInstallCommand,
  formatByteSize,
  nativeBuildArtifacts,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  nativeBuildTarget,
  simulatorInstallCommand,
} from "@/lib/native-builds";

import { CopyableText } from "./CopyableText";

/** A phone scans the storage URL, which needs no console sign-in. */
function ApkQrCode({ build }: { readonly build: NativeBuildRow }) {
  const downloadUrl = useNativeBuildDownloadUrlQuery(build.id, true);
  const url = downloadUrl.data?.url;

  // A storage without download URLs serves the build only through the
  // console, which a phone that scans isn't signed in to.
  if (url === null) {
    return (
      <p className="text-xs text-muted-foreground">
        This storage gives no download link a phone can open without signing in,
        so there is no QR code. Download the APK below, or open this page on the
        phone signed in to the console.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {url === undefined ? (
        downloadUrl.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>The download link couldn't be created</AlertTitle>
            <AlertDescription>{downloadUrl.error.message}</AlertDescription>
          </Alert>
        ) : (
          <Skeleton className="size-48" />
        )
      ) : (
        <QrCode
          className="size-48"
          label={`Download ${nativeBuildFileName(build)}`}
          value={url}
        />
      )}
      <p className="text-center text-xs text-muted-foreground">
        Scan with an Android phone's camera, then open the APK to install it.
      </p>
    </div>
  );
}

function InstallSteps({ build }: { readonly build: NativeBuildRow }) {
  switch (build.artifact_kind) {
    case "apk":
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <ApkQrCode build={build} />
          <p className="text-xs text-muted-foreground">On an emulator:</p>
          <CopyableText
            label="the install command"
            value={apkInstallCommand(build)}
          />
        </div>
      );
    case "app":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Download the archive, then install it on the booted simulator:
          </p>
          <CopyableText
            label="the install command"
            value={simulatorInstallCommand(build)}
          />
        </div>
      );
    default:
      return (
        <p className="text-xs text-muted-foreground">
          An {nativeBuildArtifacts[build.artifact_kind].label} installs through{" "}
          {nativeBuildArtifacts[build.artifact_kind].installs}, not from a QR
          code.
        </p>
      );
  }
}

/**
 * Installs one native build: an APK by QR code, a simulator app with
 * `xcrun simctl`, and any artifact by download. The build is read by ID
 * only when the list on screen doesn't hold it, as when a link opens it.
 */
export function InstallBuildDialog({
  buildId,
  listed,
  channelName,
  onClose,
}: {
  readonly buildId: string | undefined;
  readonly listed: NativeBuildRow | undefined;
  readonly channelName: (channelId: string) => string;
  readonly onClose: () => void;
}) {
  const query = useNativeBuildQuery(buildId ?? "", listed);
  const build = query.data;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={buildId !== undefined}
    >
      <DialogContent className="sm:max-w-md">
        {build ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <PlatformIcon
                  className="size-3.5 text-muted-foreground"
                  platform={build.platform}
                />
                Install {nativeBuildArtifacts[build.artifact_kind].label}
              </DialogTitle>
              <DialogDescription>
                <span translate="no">{channelName(build.channel_id)}</span> ·{" "}
                {nativeBuildTarget(build).label}{" "}
                <span className="font-mono" translate="no">
                  {nativeBuildTarget(build).value.slice(0, 12)}
                </span>{" "}
                · {formatByteSize(build.byte_size)}
              </DialogDescription>
            </DialogHeader>
            <InstallSteps build={build} />
            <a
              className={buttonVariants({
                className: "min-h-11 w-full min-w-0 sm:min-h-8",
                variant: build.artifact_kind === "apk" ? "outline" : "default",
              })}
              download
              href={nativeBuildDownloadPath(build.id)}
            >
              <Download data-icon="inline-start" />
              <span className="truncate">
                Download {nativeBuildFileName(build)}
              </span>
            </a>
          </>
        ) : query.isLoading ? (
          <>
            <DialogHeader>
              <DialogTitle>Loading build</DialogTitle>
            </DialogHeader>
            <Skeleton className="h-48 w-full" />
          </>
        ) : (
          <DialogHeader>
            <DialogTitle>Build not found</DialogTitle>
            <DialogDescription>
              {query.isError
                ? query.error.message
                : "No native build has this ID. It may be from another console."}
            </DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}

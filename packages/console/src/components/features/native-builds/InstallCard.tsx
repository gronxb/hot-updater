import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { AlertTriangle, Download } from "lucide-react";

import { QrCode } from "@/components/QrCode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useNativeBuildDownloadUrlQuery } from "@/lib/api";
import {
  apkInstallCommand,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  simulatorInstallCommand,
} from "@/lib/native-builds";

import { CopyableText } from "./CopyableText";
import { isSubmitted } from "./StoreSubmission";

/**
 * What scanning a build's QR code gets, by its artifact. The install steps
 * beside it add only what this doesn't say, so the card says each thing once.
 */
const QR_CAPTIONS: Record<NativeBuildRow["artifact_kind"], string> = {
  apk: "Scan with an Android phone's camera, then open the APK to install it.",
  ipa: "Scan to download the .ipa. It installs only on devices its signing profile allows (development or ad hoc); an App Store export reaches testers through TestFlight.",
  aab: "Scan to download the .aab. It installs through Google Play or bundletool, not from the file.",
  app: "Scan to download the .app.zip on a Mac.",
};

/**
 * The QR code of the build's download: the storage's URL, which a phone
 * opens without the console's sign-in, read again before it expires.
 */
function DownloadQrCode({ build }: { readonly build: NativeBuildRow }) {
  const downloadUrl = useNativeBuildDownloadUrlQuery(build.id, true);
  const url = downloadUrl.data?.url;

  // A storage without download URLs serves the build only through the
  // console, which a phone that scans isn't signed in to.
  if (url === null) {
    return (
      <p className="text-xs text-muted-foreground">
        This storage gives no download link a phone can open without signing in,
        so there is no QR code. Download the build here, or open this page on
        the phone signed in to the console.
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
      <p className="max-w-56 text-center text-xs text-muted-foreground">
        {QR_CAPTIONS[build.artifact_kind]}
      </p>
    </div>
  );
}

/** The store's label of a submitted build. */
function SubmittedVersion({ build }: { readonly build: NativeBuildRow }) {
  return (
    <span className="font-mono text-foreground" translate="no">
      {build.submitted_version ?? "this build"}
    </span>
  );
}

/**
 * How else the artifact installs, beside its QR code's caption and its
 * download: none of it repeats the caption.
 */
function InstallSteps({ build }: { readonly build: NativeBuildRow }) {
  switch (build.artifact_kind) {
    case "apk":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            On an emulator or a phone over USB, download the APK and install it:
          </p>
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
            It runs only in the iOS Simulator. Install it on the booted one:
          </p>
          <CopyableText
            label="the install command"
            value={simulatorInstallCommand(build)}
          />
        </div>
      );
    case "aab":
      return isSubmitted(build) ? (
        <p className="text-xs text-muted-foreground">
          Submitted to Google Play internal testing as{" "}
          <SubmittedVersion build={build} />. Testers get it once its release is
          rolled out; on an app Play Console hasn't published, the release is a
          draft you roll out in Play Console.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            For testers, build and release to internal testing:
          </p>
          <CopyableText
            label="the Google Play command"
            value="npx hot-updater google-play upload"
          />
        </div>
      );
    case "ipa":
      return isSubmitted(build) ? (
        <p className="text-xs text-muted-foreground">
          On TestFlight as <SubmittedVersion build={build} />.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Over USB, Xcode or Apple Configurator installs it. For testers:
          </p>
          <CopyableText
            label="the TestFlight command"
            value="npx hot-updater testflight"
          />
        </div>
      );
  }
}

/**
 * Installs one native build: every artifact by a QR code of its download,
 * which a phone scans, and by download here; an APK also with `adb`, a
 * simulator app with `xcrun simctl`, and an IPA's or an AAB's testers through
 * its store.
 */
export function InstallCard({ build }: { readonly build: NativeBuildRow }) {
  const fileName = nativeBuildFileName(build);
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Install</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 p-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:p-6">
        <DownloadQrCode build={build} />
        <div className="flex min-w-0 flex-col gap-4">
          <InstallSteps build={build} />
          <a
            className={buttonVariants({
              className:
                "h-auto min-h-11 w-full min-w-0 py-2 whitespace-normal sm:min-h-8 sm:w-fit",
              variant: "outline",
            })}
            download
            href={nativeBuildDownloadPath(build.id)}
          >
            <Download data-icon="inline-start" />
            <span className="text-left [overflow-wrap:anywhere]">
              Download {fileName}
            </span>
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

import type { NativeBuildRow } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import { AlertTriangle, Download } from "lucide-react";

import { QrCode } from "@/components/QrCode";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useNativeBuildDownloadLinkQuery,
  useNativeBuildDownloadUrlQuery,
} from "@/lib/api";
import {
  apkInstallCommand,
  nativeBuildDownloadPath,
  nativeBuildFileName,
  nativeBuildSignedDownloadUrl,
  simulatorInstallCommand,
} from "@/lib/native-builds";
import type { NativeBuildDownloadLinkResult } from "@/lib/server/nativeBuildDownloadLink";

import { CopyableText } from "./CopyableText";
import { isSubmitted } from "./StoreSubmission";

/**
 * What an artifact installs on, where the file alone isn't enough: the card
 * says it once, under the QR code, or without one, in its place.
 */
const INSTALL_LIMITS: Partial<Record<NativeBuildRow["artifact_kind"], string>> =
  {
    ipa: "The .ipa installs only on devices its signing profile allows (development or ad hoc); an App Store export reaches testers through TestFlight.",
    aab: "The .aab installs through Google Play or bundletool, not from the file.",
  };

/**
 * What scanning a build's QR code gets, by its artifact. The install steps
 * beside it add only what this doesn't say, so the card says each thing once.
 */
const QR_CAPTIONS: Record<NativeBuildRow["artifact_kind"], string> = {
  apk: "Scan with an Android phone's camera, then open the APK to install it.",
  ipa: `Scan to download. ${INSTALL_LIMITS.ipa}`,
  aab: `Scan to download. ${INSTALL_LIMITS.aab}`,
  app: "Scan to download the .app.zip on a Mac.",
};

/** A QR code of the build's download URL, with what scanning it gets. */
function ScannableUrl({
  build,
  url,
  note,
}: {
  readonly build: NativeBuildRow;
  readonly url: string;
  readonly note?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <QrCode
        className="size-48"
        label={`Download ${nativeBuildFileName(build)}`}
        value={url}
      />
      <p className="max-w-56 text-center text-xs text-muted-foreground">
        {QR_CAPTIONS[build.artifact_kind]}
      </p>
      {note ? (
        <p className="max-w-56 text-center text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function QrProblem({ message }: { readonly message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>The download link couldn't be created</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * The QR code when the Console can't sign a link: the storage's URL, which a
 * phone opens without the Console's sign-in, but only until it expires.
 */
function StorageQrCode({ build }: { readonly build: NativeBuildRow }) {
  const downloadUrl = useNativeBuildDownloadUrlQuery(build.id);
  const url = downloadUrl.data?.url;

  // A storage without download URLs serves the build only through the
  // console, which a phone that scans isn't signed in to.
  if (url === null) {
    const limits = INSTALL_LIMITS[build.artifact_kind];
    return (
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>
          This storage gives no download link a phone can open without signing
          in, so there is no QR code. Download the build here, or open this page
          on the phone signed in to the console.
        </p>
        {limits ? <p>{limits}</p> : null}
      </div>
    );
  }
  if (url !== undefined) {
    return (
      <ScannableUrl
        build={build}
        note="This link expires. If the download fails, reload this page."
        url={url}
      />
    );
  }
  return downloadUrl.isError ? (
    <QrProblem message={downloadUrl.error.message} />
  ) : (
    <Skeleton className="size-48" />
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
            Your browser needs the "Install unknown apps" permission.
          </p>
          <p className="text-xs text-muted-foreground">
            If this package is already installed with another signing key, such
            as a Play copy, the install fails. A sandbox build's{" "}
            <span className="font-mono text-foreground" translate="no">
              .sandbox
            </span>{" "}
            applicationId installs beside it.
          </p>
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
 * The signed link to copy, which a script or a teammate uses without signing
 * in. A local Console has none, and says nothing about it on every build.
 */
function SignedLink({
  link,
  url,
}: {
  readonly link: NativeBuildDownloadLinkResult | undefined;
  readonly url: string | null;
}) {
  if (link?.status === "no-secret") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Set {link.secretName} on the Console to create links.
      </p>
    );
  }
  if (link?.status !== "issued" || url === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CopyableText label="the download link" value={url} />
      <p className="text-xs text-muted-foreground">
        Anyone with this link can download this build until{" "}
        {dayjs(link.expiresAt).format("YYYY-MM-DD")}.
      </p>
    </div>
  );
}

/**
 * Installs one native build: every artifact by a QR code of its signed link,
 * which a phone without a session scans, and by download here or the link
 * itself; an APK also with `adb`, a simulator app with `xcrun simctl`, and an
 * IPA's or an AAB's testers through its store. Where the Console can't sign,
 * the QR code holds the storage's URL and the download asks for the session.
 */
export function InstallCard({ build }: { readonly build: NativeBuildRow }) {
  const fileName = nativeBuildFileName(build);
  const link = useNativeBuildDownloadLinkQuery(build.id);
  const signedUrl =
    link.data?.status === "issued"
      ? nativeBuildSignedDownloadUrl(window.location, build.id, link.data.token)
      : null;
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Install</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 p-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:p-6">
        {signedUrl !== null ? (
          <ScannableUrl build={build} url={signedUrl} />
        ) : link.data !== undefined ? (
          <StorageQrCode build={build} />
        ) : link.isError ? (
          <QrProblem message={link.error.message} />
        ) : (
          <Skeleton className="size-48" />
        )}
        <div className="flex min-w-0 flex-col gap-4">
          <InstallSteps build={build} />
          <a
            className={buttonVariants({
              className:
                "h-auto min-h-11 w-full min-w-0 py-2 whitespace-normal sm:min-h-8 sm:w-fit",
              variant: "outline",
            })}
            download
            href={signedUrl ?? nativeBuildDownloadPath(build.id)}
          >
            <Download data-icon="inline-start" />
            <span className="text-left [overflow-wrap:anywhere]">
              Download {fileName}
            </span>
          </a>
          <SignedLink link={link.data} url={signedUrl} />
        </div>
      </CardContent>
    </Card>
  );
}

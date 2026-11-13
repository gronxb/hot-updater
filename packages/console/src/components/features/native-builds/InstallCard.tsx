import type { NativeBuildRow } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import { AlertTriangle, ChevronRight, Download } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

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
  nativeBuildDownloadPath,
  nativeBuildFileName,
  nativeBuildInstallCommand,
  nativeBuildSignedDownloadUrl,
} from "@/lib/native-builds";
import type { NativeBuildDownloadLinkResult } from "@/lib/server/nativeBuildDownloadLink";

import { CopyableText } from "./CopyableText";
import { IosInstall, useIosDevice } from "./IosInstall";
import {
  isSubmitted,
  StoreSubmissionBadge,
  type Submitted,
} from "./StoreSubmission";

const IPA_LIMIT =
  "The .ipa installs only on devices its signing profile allows (development or ad hoc)";

/**
 * What an artifact installs on, where the file alone isn't enough: the card
 * says it once, under the QR code, or without one, in its place. A sandbox
 * build gets no TestFlight advice.
 */
const installLimit = (build: NativeBuildRow): string | undefined => {
  switch (build.artifact_kind) {
    case "ipa":
      return build.is_sandbox
        ? `${IPA_LIMIT}.`
        : `${IPA_LIMIT}; an App Store export reaches testers through TestFlight.`;
    case "aab":
      return "The .aab installs through Google Play or bundletool, not from the file.";
    default:
      return undefined;
  }
};

/**
 * What scanning a build's QR code gets, by its artifact. The install steps
 * beside it add only what this doesn't say, so the card says each thing once.
 */
const qrCaption = (build: NativeBuildRow): string => {
  switch (build.artifact_kind) {
    case "apk":
      return "Scan with an Android phone's camera, then open the APK to install it.";
    case "app":
      return "Scan to download the .app.zip on a Mac.";
    default:
      return `Scan to download. ${installLimit(build)}`;
  }
};

/**
 * An IPA's QR code holds this page rather than a file: the iPhone that scans it
 * checks whether the IPA lists it before anything downloads, and installs here.
 */
function ScannablePage() {
  const { origin, pathname } = window.location;
  return (
    <div className="flex flex-col items-center gap-2">
      <QrCode
        className="size-48"
        label="Open this page on an iPhone"
        value={`${origin}${pathname}`}
      />
      <p className="max-w-56 text-center text-xs text-muted-foreground">
        Scan with an iPhone to install this build from here. The phone signs in
        to the Console first.
      </p>
    </div>
  );
}

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
        {qrCaption(build)}
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
    const limits = installLimit(build);
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

/**
 * The file's download, as an outline button where people use the file itself.
 * An IPA's is a ghost button in the same place: a computer's browser installs
 * nothing from it, so it never competes with the card's install path.
 */
function DownloadButton({
  build,
  href,
}: {
  readonly build: NativeBuildRow;
  readonly href: string;
}) {
  return (
    <a
      className={buttonVariants({
        className:
          "h-auto min-h-11 w-full min-w-0 py-2 whitespace-normal sm:min-h-8 sm:w-fit",
        variant: build.artifact_kind === "ipa" ? "ghost" : "outline",
      })}
      download
      href={href}
    >
      <Download data-icon="inline-start" />
      <span className="text-left [overflow-wrap:anywhere]">
        Download {nativeBuildFileName(build)}
      </span>
    </a>
  );
}

/**
 * A build a store took installs from the store, so the card leads with the
 * store's badge, says how testers get it, and keeps the file's download, with
 * no QR code or signed link to ask for.
 */
function StoreInstallCard({ build }: { readonly build: Submitted }) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Install</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
        <StoreSubmissionBadge build={build} withTime />
        <InstallSteps build={build} />
        <DownloadButton
          build={build}
          href={nativeBuildDownloadPath(build.id)}
        />
      </CardContent>
    </Card>
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
          {build.is_sandbox ? (
            // It already is the build the advice below points to.
            <p className="text-xs text-muted-foreground">
              Its .sandbox ID installs it beside a Play copy.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              If this package is already installed with another signing key,
              such as a Play copy, the install fails. Uninstall that copy first,
              or build with sandbox: true, whose .sandbox ID installs beside it.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            On an emulator or a phone over USB, install and open it from your
            project:
          </p>
          <CopyableText
            label="the install command"
            value={nativeBuildInstallCommand(build)}
          />
        </div>
      );
    case "app":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            It runs only in the iOS Simulator. In your project, install and open
            it on the booted one:
          </p>
          <CopyableText
            label="the install command"
            value={nativeBuildInstallCommand(build)}
          />
        </div>
      );
    case "aab":
      return isSubmitted(build) ? (
        // The store's badge above says where it went and as what.
        <p className="text-xs text-muted-foreground">
          {build.submitted_to === "play-production" ? "Users" : "Testers"} get
          it once its release is rolled out; on an app Play Console hasn't
          published, the release is a draft you roll out in Play Console.
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
          Internal testers install it from the TestFlight app once App Store
          Connect has processed it.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Over USB, Xcode or Apple Configurator installs it.
        </p>
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
        <span className="whitespace-nowrap">
          {dayjs(link.expiresAt).format("YYYY-MM-DD")}.
        </span>
      </p>
    </div>
  );
}

/**
 * Installs one native build: an IPA or AAB a store took, from the store, which
 * its badge names, with the file's download; an IPA
 * on the iPhone that opens this page, whose QR code on any other screen holds
 * this page; every other artifact by a QR code of its signed link, which a phone
 * without a session scans, and by download here or the link itself; an APK or a
 * simulator app also with `native-build install`, and an IPA's or an AAB's
 * testers through its store. Where the Console can't sign, the QR code holds the
 * storage's URL and the download asks for the session.
 */
export function InstallCard({ build }: { readonly build: NativeBuildRow }) {
  return isSubmitted(build) &&
    (build.artifact_kind === "ipa" || build.artifact_kind === "aab") ? (
    <StoreInstallCard build={build} />
  ) : (
    <FileInstallCard build={build} />
  );
}

/**
 * On the iPhone, what installs the IPA from a computer, closed under the one
 * action this phone takes: over USB, the download, and its link.
 */
function OtherWaysToInstall({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t pt-3">
      <button
        aria-controls={id}
        aria-expanded={open}
        className="group/other -mx-1 flex min-h-11 items-center gap-1.5 self-start rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none sm:min-h-8"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-aria-expanded/other:rotate-90 motion-reduce:transition-none"
        />
        Other ways to install
      </button>
      <div hidden={!open} id={id}>
        {children}
      </div>
    </div>
  );
}

function FileInstallCard({ build }: { readonly build: NativeBuildRow }) {
  const link = useNativeBuildDownloadLinkQuery(build.id);
  const signedUrl =
    link.data?.status === "issued"
      ? nativeBuildSignedDownloadUrl(window.location, build.id, link.data.token)
      : null;
  const device = useIosDevice();
  const ipa = build.artifact_kind === "ipa";
  const onPhone = ipa && device?.ios === true;
  const otherWays = (
    <div className="flex min-w-0 flex-col gap-4">
      <InstallSteps build={build} />
      <DownloadButton
        build={build}
        href={signedUrl ?? nativeBuildDownloadPath(build.id)}
      />
      <SignedLink link={link.data} url={signedUrl} />
    </div>
  );
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Install</h2>
        </CardTitle>
      </CardHeader>
      {onPhone ? (
        <CardContent className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
          <IosInstall build={build} device={device} />
          <OtherWaysToInstall>{otherWays}</OtherWaysToInstall>
        </CardContent>
      ) : (
        <CardContent className="grid gap-6 p-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:p-6">
          {ipa && signedUrl !== null ? (
            <ScannablePage />
          ) : signedUrl !== null ? (
            <ScannableUrl build={build} url={signedUrl} />
          ) : link.data !== undefined ? (
            <StorageQrCode build={build} />
          ) : link.isError ? (
            <QrProblem message={link.error.message} />
          ) : (
            <Skeleton className="size-48" />
          )}
          {otherWays}
        </CardContent>
      )}
    </Card>
  );
}

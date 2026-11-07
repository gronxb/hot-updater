import type { NativeBuildRow } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import { AlertTriangle, Smartphone } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useNativeBuildInstallEligibilityQuery } from "@/lib/api";
import {
  consolePathOf,
  IOS_UDID_PATTERN,
  IOS_UDID_STORAGE_KEY,
  NATIVE_BUILD_INSTALL_LINK_TTL_MS,
  nativeBuildDeviceAddCommand,
  nativeBuildDeviceProfilePath,
  nativeBuildItmsUrl,
} from "@/lib/native-builds";

import { CopyableText } from "./CopyableText";

/**
 * What an install does to the App Store's copy of the app on this iPhone, with
 * the same bundle ID. The one line to change after trying it on a real iPhone.
 */
export const IOS_STORE_APP_NOTE =
  "With the same bundle ID, this install replaces the App Store's copy of the app on this iPhone.";

const ACTION_CLASS =
  "h-auto min-h-11 w-full min-w-0 py-2 whitespace-normal sm:min-h-8 sm:w-fit";

/** Whether this browser runs on an iPhone or iPad: an iPad says it is a Mac. */
export const isIosBrowser = (
  browser: Pick<Navigator, "userAgent" | "maxTouchPoints">,
) =>
  /iPhone|iPod|iPad/u.test(browser.userAgent) ||
  (/Macintosh/u.test(browser.userAgent) && browser.maxTouchPoints > 1);

/**
 * Whether this page is open on an iPhone, and the UDID the phone kept when it
 * checked itself. Read after the page mounts: the server renders it without a
 * browser. Null until then.
 */
export const useIosDevice = () => {
  const [device, setDevice] = useState<{
    readonly ios: boolean;
    readonly udid: string | null;
  } | null>(null);
  useEffect(() => {
    let udid: string | null = null;
    try {
      udid = window.localStorage.getItem(IOS_UDID_STORAGE_KEY);
    } catch {
      // A browser that keeps nothing: this iPhone checks itself each time.
    }
    setDevice({
      ios: isIosBrowser(navigator),
      udid: udid !== null && IOS_UDID_PATTERN.test(udid) ? udid : null,
    });
  }, []);
  return device;
};

/**
 * How long before its link expires the page stops offering it: the installer
 * fetches the manifest, then the IPA, only after the tester confirms the prompt.
 */
const INSTALL_LINK_MARGIN_MS = 5 * 60 * 1000;

/**
 * Whether a link read at `readAtMs` is past offering, measured on this phone's
 * clock from when it arrived, since the phone's clock may disagree with the
 * server's. A failed refresh leaves `readAtMs` where it was. Timers stop while
 * the phone sleeps, so coming back to the page checks again.
 */
const useInstallLinkExpired = (readAtMs: number, holdsLink: boolean) => {
  const [, check] = useReducer((count: number) => count + 1, 0);
  const expiresAtMs =
    readAtMs + NATIVE_BUILD_INSTALL_LINK_TTL_MS - INSTALL_LINK_MARGIN_MS;
  useEffect(() => {
    if (!holdsLink) return;
    const timer = setTimeout(check, Math.max(0, expiresAtMs - Date.now()));
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, [expiresAtMs, holdsLink]);
  return holdsLink && Date.now() >= expiresAtMs;
};

/** In place of Install once its link has expired: it never offers a dead link. */
function RenewInstallLink({
  fetching,
  onRenew,
}: {
  readonly fetching: boolean;
  readonly onRenew: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground" role="status">
        This install link has expired.{fetching ? " Getting a new one." : ""}
      </p>
      {fetching ? null : (
        <Button className={ACTION_CLASS} onClick={onRenew} variant="outline">
          Get a new link
        </Button>
      )}
    </div>
  );
}

function InstallButton({
  build,
  token,
  secondary = false,
}: {
  readonly build: NativeBuildRow;
  readonly token: string;
  readonly secondary?: boolean;
}) {
  return (
    <a
      className={buttonVariants({
        className: ACTION_CLASS,
        variant: secondary ? "outline" : "default",
      })}
      href={nativeBuildItmsUrl(window.location, build.id, token)}
    >
      {secondary ? "Install anyway" : "Install"}
    </a>
  );
}

/** What a tester reads before Install opens the system's install prompt. */
function InstallNotes() {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        On iOS 16 or later, the app opens only with Developer Mode on: Settings,
        Privacy &amp; Security, Developer Mode.
      </p>
      <p className="text-xs text-muted-foreground">{IOS_STORE_APP_NOTE}</p>
    </div>
  );
}

/**
 * The link that hands this iPhone the profile that reads its UDID, under the
 * console's path. A plain link, so iOS offers the profile.
 */
function CheckThisIphone({
  build,
  outline = false,
}: {
  readonly build: NativeBuildRow;
  readonly outline?: boolean;
}) {
  return (
    <a
      className={buttonVariants({
        className: ACTION_CLASS,
        variant: outline ? "outline" : "default",
      })}
      href={`${consolePathOf(window.location, build.id)}${nativeBuildDeviceProfilePath(build.id)}`}
    >
      <Smartphone data-icon="inline-start" />
      Check this iPhone
    </a>
  );
}

/**
 * Installing an IPA from this iPhone: the build's IPA says what it allows, read
 * once when the page opens here, so a phone it doesn't list goes to its UDID
 * rather than a download iOS refuses at the end. App Store Connect isn't asked:
 * a device registered after this IPA was signed still isn't in it.
 */
export function IosInstall({
  build,
  udid,
}: {
  readonly build: NativeBuildRow;
  readonly udid: string | null;
}) {
  const eligibility = useNativeBuildInstallEligibilityQuery(build.id, udid);
  const { refetch } = eligibility;
  const expired = useInstallLinkExpired(
    eligibility.dataUpdatedAt,
    eligibility.data?.status === "installable",
  );
  useEffect(() => {
    if (expired) void refetch();
  }, [expired, refetch]);
  if (eligibility.isPending) {
    return <Skeleton aria-label="Reading this IPA" className="h-11 w-full" />;
  }
  const result = eligibility.data;
  if (result === undefined || result.status === "unavailable") {
    return (
      <Alert>
        <AlertTriangle />
        <AlertTitle>Installation details unavailable</AlertTitle>
        <AlertDescription>
          The Console couldn't read this IPA from storage in parts, which takes
          an HTTPS download link that answers Range requests. Xcode or Apple
          Configurator still installs the download over USB.
        </AlertDescription>
      </Alert>
    );
  }
  if (result.status === "store") {
    return (
      <p className="text-xs text-muted-foreground">
        This IPA is an App Store export, which installs through TestFlight, not
        from this page.
      </p>
    );
  }
  if (result.status === "expired") {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>This build's profile has expired</AlertTitle>
        <AlertDescription>
          It expired on {dayjs(result.expiresAt).format("YYYY-MM-DD")}. A
          maintainer rebuilds it to install again.
        </AlertDescription>
      </Alert>
    );
  }
  const token = result.link.status === "issued" ? result.link.token : null;
  if (result.link.status === "no-secret") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Set {result.link.secretName} on the Console to install from this page.
      </p>
    );
  }
  if (token === null) return null;
  const install = ({ secondary = false } = {}) =>
    expired ? (
      <RenewInstallLink
        fetching={eligibility.isFetching}
        onRenew={() => void refetch()}
      />
    ) : (
      <InstallButton build={build} secondary={secondary} token={token} />
    );
  if (result.device === "included") {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-medium">This iPhone is in this build.</p>
        {install()}
        <InstallNotes />
      </div>
    );
  }
  if (result.device === "not-included") {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">Not in this build</p>
          <p className="text-xs text-muted-foreground">
            This IPA was signed without this iPhone. Send a maintainer this
            command, then open the newer build once they've rebuilt. Send it
            only if this is your iPhone.
          </p>
        </div>
        <CopyableText
          label="the command that registers this iPhone"
          value={nativeBuildDeviceAddCommand(udid ?? "")}
          wrap
        />
        {install({ secondary: true })}
        <InstallNotes />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium">Is this iPhone in this build?</p>
        <p className="text-xs text-muted-foreground">
          iOS installs this IPA only on the devices it lists. A profile reads
          this iPhone's ID and nothing else: allow the download, then install it
          from Settings, where iOS calls it not signed. Nothing stays installed.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <CheckThisIphone build={build} />
        {install({ secondary: true })}
      </div>
      <InstallNotes />
    </div>
  );
}

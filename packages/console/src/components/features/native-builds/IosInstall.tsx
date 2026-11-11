import type { IosDeviceRow, NativeBuildRow } from "@hot-updater/plugin-core";
import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  Send,
  Smartphone,
} from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useNativeBuildInstallEligibilityQuery } from "@/lib/api";
import {
  useIosDeviceProfileLinkQuery,
  useRequestIosDeviceAccessMutation,
} from "@/lib/ios-devices-api";
import {
  consolePathOf,
  IOS_DEVICE_RECEIPT_STORAGE_KEY,
  IOS_UDID_PATTERN,
  IOS_UDID_STORAGE_KEY,
  iosDeviceProfileUrl,
  NATIVE_BUILD_INSTALL_LINK_TTL_MS,
  nativeBuildItmsUrl,
} from "@/lib/native-builds";

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
 * What the profile's answer passed back in the fragment: the UDID, with a
 * receipt of it from a check, or `requested` from a registration.
 */
const fragmentOf = () => {
  if (typeof window === "undefined") {
    return { udid: null, receipt: null, requested: false };
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  const udid = params.get("udid");
  const valid = udid !== null && IOS_UDID_PATTERN.test(udid) ? udid : null;
  return {
    udid: valid,
    receipt: valid === null ? null : params.get("r"),
    requested: valid !== null && params.get("requested") === "1",
  };
};

/** This iPhone's view of itself, as its profile last reported it. */
export interface IosDevice {
  readonly ios: boolean;
  readonly udid: string | null;
  /** The receipt of `udid` that Request access takes, when a check made one. */
  readonly receipt: string | null;
  /** Whether this page opened from a registration's answer. */
  readonly requested: boolean;
}

const readKept = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const keep = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A browser that keeps nothing: the fragment's values stand in memory.
  }
};

/**
 * Whether this page is open on an iPhone, its UDID, and a receipt of it: the
 * ones this phone kept, else the ones the profile's answer passed in the
 * fragment, which are kept then. Read after the page mounts: the server
 * renders it without a browser. Null until then.
 */
export const useIosDevice = (): IosDevice | null => {
  const [device, setDevice] = useState<IosDevice | null>(null);
  // Read at the first render, so an effect that runs again (React's
  // development check) still has it after the fragment is gone.
  const [passed] = useState(fragmentOf);
  useEffect(() => {
    const valid = (udid: string | null | undefined) =>
      udid != null && IOS_UDID_PATTERN.test(udid) ? udid : null;
    // Only the profile's own answer, which carries a receipt or says it
    // registered, replaces the ID this phone kept: a plain link's ID never does.
    const answered = passed.receipt !== null || passed.requested;
    if (passed.udid !== null && answered) {
      keep(IOS_UDID_STORAGE_KEY, passed.udid);
      if (passed.receipt !== null) {
        keep(
          IOS_DEVICE_RECEIPT_STORAGE_KEY,
          JSON.stringify({ udid: passed.udid, receipt: passed.receipt }),
        );
      }
    }
    if (passed.udid !== null && window.location.hash !== "") {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    const read = () => {
      // A browser that keeps nothing still has the fragment's, in memory.
      const udid = valid(readKept(IOS_UDID_STORAGE_KEY)) ?? passed.udid;
      let receipt: string | null = null;
      try {
        const kept = JSON.parse(
          readKept(IOS_DEVICE_RECEIPT_STORAGE_KEY) ?? "null",
        ) as { udid?: unknown; receipt?: unknown } | null;
        receipt =
          kept?.udid === udid && typeof kept?.receipt === "string"
            ? kept.receipt
            : null;
      } catch {
        receipt = null;
      }
      if (receipt === null && passed.udid === udid) receipt = passed.receipt;
      setDevice((current) =>
        current !== null && current.udid === udid && current.receipt === receipt
          ? current
          : {
              ios: isIosBrowser(navigator),
              udid,
              receipt,
              requested: passed.requested,
            },
      );
    };
    read();
    // The profile's answer may land in another tab, which keeps the ID there:
    // this tab reads it when that tab writes it, or when Safari shows it again.
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === IOS_UDID_STORAGE_KEY ||
        event.key === IOS_DEVICE_RECEIPT_STORAGE_KEY
      ) {
        read();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [passed]);
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
}: {
  readonly build: NativeBuildRow;
  readonly token: string;
}) {
  return (
    <a
      className={buttonVariants({ className: ACTION_CLASS })}
      href={nativeBuildItmsUrl(window.location, build.id, token)}
    >
      Install
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
 * The link that hands this iPhone the profile that reads its UDID, signed for
 * this person, under the Console's path. A plain link, so iOS offers the
 * profile; the page signs a new one before it expires. Once it's installed,
 * the phone comes back to this page with the UDID and a receipt of it.
 */
function CheckThisIphone({
  build,
  again = false,
}: {
  readonly build: NativeBuildRow;
  /** For a phone whose kept ID isn't its own, or whose check expired. */
  readonly again?: boolean;
}) {
  const link = useIosDeviceProfileLinkQuery({
    mode: "identify",
    buildId: build.id,
  });
  if (link.data?.status === "no-secret") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Set {link.data.secretName} on the Console to check iPhones from this
        page.
      </p>
    );
  }
  if (link.data?.status !== "issued") {
    return link.isError ? (
      <>
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>The check couldn't start</AlertTitle>
          <AlertDescription>Check your connection and try again.</AlertDescription>
        </Alert>
        <Button
          className={ACTION_CLASS}
          disabled={link.isFetching}
          onClick={() => void link.refetch()}
          variant="outline"
        >
          <RefreshCw data-icon="inline-start" />
          Reload
        </Button>
      </>
    ) : (
      <Skeleton aria-label="Preparing the check" className="h-11 w-full" />
    );
  }
  return (
    <>
      <a
        className={buttonVariants({
          className: ACTION_CLASS,
          variant: again ? "secondary" : "default",
        })}
        href={iosDeviceProfileUrl(
          consolePathOf(window.location, build.id),
          link.data.token,
        )}
      >
        <Smartphone data-icon="inline-start" />
        {again ? "Check this iPhone again" : "Check this iPhone"}
      </a>
      <p className="text-xs text-muted-foreground">
        Allow the download, then install it in Settings, where iOS calls it not
        signed. Nothing stays installed.
      </p>
    </>
  );
}

const shortDate = (ms: number) => dayjs(ms).format("MMM D");

/**
 * Apple's refusal of this iPhone, in its own words, and the one next step: the
 * iOS devices page for an approver, else whom to ask.
 */
function AppleRefusal({
  device,
  canApprove,
}: {
  readonly device: IosDeviceRow;
  readonly canApprove: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Alert>
        <AlertTriangle />
        <AlertTitle>Apple didn't register this iPhone</AlertTitle>
        <AlertDescription>{device.apple_error}</AlertDescription>
      </Alert>
      {canApprove ? (
        <Link
          className={buttonVariants({
            className: ACTION_CLASS,
            variant: "outline",
          })}
          to="/native-builds/devices"
        >
          iOS devices
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">
          {device.status === "approved"
            ? "Ask a maintainer to free a device slot."
            : "Ask a maintainer to check it on the iOS devices page."}
        </p>
      )}
    </div>
  );
}

/**
 * What an iPhone the IPA doesn't list sees: the registry's word on it, or
 * Request access, which takes the UDID from this person's receipt alone.
 */
function NotInThisBuild({
  build,
  device,
  registry,
  newerBuild,
  canApprove,
  registryReadAt,
}: {
  readonly build: NativeBuildRow;
  readonly device: IosDevice;
  readonly registry: IosDeviceRow | null;
  /**
   * The newer build of this app and channel that lists the iPhone, as the
   * server matched `registry.build_id`, or null.
   */
  readonly newerBuild: string | null;
  /** Whether the viewer approves devices, read only under Apple's refusal. */
  readonly canApprove: boolean;
  /** When the page last read `registry`. */
  readonly registryReadAt: number;
}) {
  const request = useRequestIosDeviceAccessMutation();
  const [name, setName] = useState("");
  // The request's answer stands in only while the page still shows the
  // registry read before the request started: any read after that wins, an
  // approval or a removal too, even one the mutation's own refresh finished
  // before its answer reached this component.
  const [requested, setRequested] = useState<{
    readonly device: IosDeviceRow;
    readonly readBefore: number;
  } | null>(null);
  const standIn = requested !== null && registryReadAt <= requested.readBefore;
  const row = standIn ? requested.device : registry;
  const heading = (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-sm font-medium">Not in this build</p>
      <p className="text-xs text-muted-foreground">
        This IPA was signed without this iPhone, and iOS won't install it here.
      </p>
    </div>
  );
  if (row !== null) {
    // The row's build_id may name a sandbox's or another app's build: only the
    // server's match of it is offered.
    const newer = standIn ? null : newerBuild;
    if (row.apple_error !== null && newer === null) {
      return <AppleRefusal canApprove={canApprove} device={row} />;
    }
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {heading}
        <p className="text-sm" role="status">
          {row.status === "pending"
            ? `${row.name} was requested on ${shortDate(row.created_at_ms)}. A maintainer approves it next.`
            : newer !== null
              ? `A newer build has ${row.name}.`
              : `${row.name} is ${row.status}. It joins the next ad hoc build.`}
        </p>
        {newer !== null ? (
          <Link
            className={buttonVariants({ className: ACTION_CLASS })}
            params={{ buildId: newer }}
            to="/native-builds/$buildId"
          >
            Open the newer build
          </Link>
        ) : null}
      </div>
    );
  }
  if (device.receipt === null) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {heading}
        <p className="text-xs text-muted-foreground">
          Check this iPhone once more to request it for the next ad hoc build.
        </p>
        <CheckThisIphone build={build} again />
      </div>
    );
  }
  const trimmed = name.trim();
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === "") return;
        const readBefore = registryReadAt;
        request.mutate(
          { receipt: device.receipt!, name: trimmed },
          {
            onSuccess: ({ device: saved }) =>
              setRequested({ device: saved, readBefore }),
          },
        );
      }}
    >
      {heading}
      <Field data-invalid={request.isError || undefined}>
        <FieldLabel htmlFor="ios-device-name">This iPhone's name</FieldLabel>
        <Input
          autoComplete="off"
          className="h-11 sm:h-8"
          id="ios-device-name"
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          placeholder="Kim's iPhone"
          value={name}
        />
        <FieldDescription>
          A maintainer approves it, and it joins the next ad hoc build.
        </FieldDescription>
        <FieldError>
          {request.isError
            ? "The request didn't go through. Check this iPhone again, then try once more."
            : null}
        </FieldError>
      </Field>
      <Button
        className={ACTION_CLASS}
        disabled={trimmed === "" || request.isPending}
        type="submit"
      >
        {request.isPending ? (
          <Loader2
            className="animate-spin motion-reduce:animate-none"
            data-icon="inline-start"
          />
        ) : (
          <Send data-icon="inline-start" />
        )}
        Request access
      </Button>
      {request.isError ? <CheckThisIphone again build={build} /> : null}
    </form>
  );
}

/**
 * Installing an IPA from this iPhone: the build's IPA says what it allows, read
 * once when the page opens here, so a phone it doesn't list goes to Request
 * access rather than a download iOS refuses at the end. App Store Connect isn't
 * asked: a device registered after this IPA was signed still isn't in it.
 */
export function IosInstall({
  build,
  device,
}: {
  readonly build: NativeBuildRow;
  readonly device: IosDevice;
}) {
  const { udid } = device;
  const eligibility = useNativeBuildInstallEligibilityQuery(build.id, udid);
  const { refetch } = eligibility;
  const expired = useInstallLinkExpired(
    eligibility.dataUpdatedAt,
    eligibility.data?.status === "installable" &&
      eligibility.data.device === "included",
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
          an HTTPS download link that answers Range requests. Other ways to
          install still work from a computer.
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
  if (result.device === "included") {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-medium">In this build</p>
        {expired ? (
          <RenewInstallLink
            fetching={eligibility.isFetching}
            onRenew={() => void refetch()}
          />
        ) : (
          <InstallButton build={build} token={token} />
        )}
        <InstallNotes />
      </div>
    );
  }
  if (result.device === "not-included") {
    return (
      <NotInThisBuild
        build={build}
        device={device}
        registry={result.registry}
        newerBuild={result.newerBuild}
        canApprove={result.canApprove}
        registryReadAt={eligibility.dataUpdatedAt}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium">Check this iPhone first</p>
        <p className="text-xs text-muted-foreground">
          iOS installs this IPA only on the devices it lists. A profile reads
          this iPhone's ID, then Safari comes back here.
        </p>
      </div>
      <CheckThisIphone build={build} />
    </div>
  );
}

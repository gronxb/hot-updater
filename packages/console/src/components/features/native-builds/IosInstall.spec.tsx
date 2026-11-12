import type { IosDeviceRow, NativeBuildRow } from "@hot-updater/plugin-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IOS_DEVICE_RECEIPT_STORAGE_KEY,
  IOS_UDID_STORAGE_KEY,
  NATIVE_BUILD_INSTALL_LINK_TTL_MS,
} from "@/lib/native-builds";
import type { NativeBuildInstallEligibility } from "@/lib/server/nativeBuildInstall";

import { InstallCard } from "./InstallCard";
import { IOS_STORE_APP_NOTE, IosInstall, isIosBrowser } from "./IosInstall";

const {
  downloadLinkQuery,
  downloadUrlQuery,
  installEligibilityQuery,
  profileLinkQuery,
  keptQuery,
  keepReceipt,
  requestAccess,
} = vi.hoisted(() => ({
  keptQuery: vi.fn(),
  keepReceipt: vi.fn(async () => null),
  downloadLinkQuery: vi.fn(),
  downloadUrlQuery: vi.fn(),
  installEligibilityQuery: vi.fn(),
  profileLinkQuery: vi.fn(),
  requestAccess: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  },
}));

vi.mock("@/lib/api", () => ({
  useNativeBuildDownloadLinkQuery: downloadLinkQuery,
  useNativeBuildDownloadUrlQuery: downloadUrlQuery,
  useNativeBuildInstallEligibilityQuery: installEligibilityQuery,
}));
vi.mock("@/lib/ios-devices-api", async (importOriginal) => ({
  keptIsThisIphone: (
    await importOriginal<typeof import("@/lib/ios-devices-api")>()
  ).keptIsThisIphone,
  useIosDeviceProfileLinkQuery: profileLinkQuery,
  useKeptIosDeviceQuery: keptQuery,
  keepIosDeviceReceipt: keepReceipt,
  useRequestThisIphoneMutation: () => requestAccess,
}));
// The newer build's link renders as an anchor without a router.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { buildId: string };
    children: unknown;
  }) => (
    <a
      href={params === undefined ? to : to.replace("$buildId", params.buildId)}
      {...props}
    >
      {children as never}
    </a>
  ),
}));

const BUILD = "019a0000-0000-7000-8000-00000000b001";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const TOKEN = "1893456000.signature";
const CAPABILITY = "capability.signature";
const RECEIPT = "receipt.signature";

/** This iPhone as the page knows it: its UDID, and a receipt from a check. */
const phone = (
  udid: string | null,
  receipt: string | null = null,
): {
  ios: boolean;
  udid: string | null;
  receipt: string | null;
  requested: boolean;
  answers: number;
} => ({
  ios: true,
  udid,
  receipt,
  requested: false,
  answers: 0,
});

const registryRow = (overrides: Partial<IosDeviceRow> = {}): IosDeviceRow => ({
  id: "01a1c984-724b-7de1-89a1-c93003b4ff49",
  udid: PHONE.toLowerCase(),
  name: "Kim's iPhone",
  status: "pending",
  requested_by: "kim@team.dev",
  created_at_ms: Date.parse("2026-11-11T00:00:00Z"),
  approved_by: null,
  approved_at_ms: null,
  registered_at_ms: null,
  apple_issuer_id: null,
  apple_error: null,
  build_id: null,
  ...overrides,
});
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const row = {
  id: BUILD,
  platform: "ios",
  artifact_kind: "ipa",
  artifact_storage_uri: "s3://bucket/native-builds/ios/App.ipa",
  submitted_to: null,
} as unknown as NativeBuildRow;

const refetch = vi.fn(async () => undefined);

const answer = (
  data: NativeBuildInstallEligibility,
  query: { dataUpdatedAt?: number; isFetching?: boolean } = {},
) =>
  installEligibilityQuery.mockReturnValue({
    data,
    isPending: false,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    refetch,
    ...query,
  });

const installable = (
  device: "unknown" | "included" | "not-included",
  registry: IosDeviceRow | null = null,
  newerBuild: string | null = null,
  canApprove = false,
): NativeBuildInstallEligibility => ({
  status: "installable",
  device,
  registry,
  newerBuild,
  canApprove,
  expiresAt: null,
  link: {
    status: "issued",
    token: TOKEN,
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
});

const manifestOf = (href: string) => {
  const url = new URL(href);
  expect(url.protocol).toBe("itms-services:");
  expect(url.searchParams.get("action")).toBe("download-manifest");
  return url.searchParams.get("url")!;
};

const link = (name: string | RegExp) =>
  screen.getByRole("link", { name }).getAttribute("href")!;

const itmsLinks = () =>
  screen
    .queryAllByRole("link")
    .filter((a) => a.getAttribute("href")?.startsWith("itms-services:"));

beforeEach(() => {
  vi.clearAllMocks();
  keptQuery.mockReturnValue({ data: { udid: null }, isPending: false });
  requestAccess.isError = false;
  requestAccess.mutate.mockReset();
  profileLinkQuery.mockReturnValue({
    data: { status: "issued", token: CAPABILITY, expiresAt: "2030-01-01" },
  });
  window.localStorage.clear();
  window.history.replaceState(null, "", `/native-builds/${BUILD}`);
});

afterEach(cleanup);

describe("isIosBrowser", () => {
  it.each([
    ["an iPhone", IPHONE_UA, 5, true],
    [
      "an iPad, which says it is a Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      5,
      true,
    ],
    ["a Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0, false],
    ["an Android phone", "Mozilla/5.0 (Linux; Android 16)", 5, false],
  ])("tells %s", (_, userAgent, maxTouchPoints, ios) => {
    expect(isIosBrowser({ userAgent, maxTouchPoints })).toBe(ios);
  });
});

describe("IosInstall", () => {
  it("shows nothing to tap while it reads the IPA", () => {
    installEligibilityQuery.mockReturnValue({
      isPending: true,
      dataUpdatedAt: 0,
      refetch,
    });
    render(<IosInstall build={row} device={phone(null)} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByLabelText("Reading this IPA")).toBeTruthy();
  });

  it("offers an unknown iPhone the check alone, signed for this person, and nothing to install yet", () => {
    answer(installable("unknown"));
    render(<IosInstall build={row} device={phone(null)} />);

    expect(profileLinkQuery).toHaveBeenCalledWith({
      mode: "identify",
      buildId: BUILD,
    });
    expect(link("Check this iPhone")).toBe(
      `/_hot-updater/devices/device.mobileconfig?t=${encodeURIComponent(CAPABILITY)}`,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(itmsLinks()).toHaveLength(0);
  });

  it("says what the check does in two sentences, and the Settings steps under its button", () => {
    answer(installable("unknown"));
    render(<IosInstall build={row} device={phone(null)} />);

    const intro = screen.getByText(/only on the devices it lists/);
    expect(intro.textContent).toBe(
      "iOS installs this IPA only on the devices it lists. A profile reads this iPhone's ID, then Safari comes back here.",
    );
    const button = screen.getByRole("link", { name: "Check this iPhone" });
    const steps = screen.getByText(/install it in Settings/);
    expect(
      button.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("turns a check that couldn't start into the card's error, with Reload that asks again in place", () => {
    const refetchLink = vi.fn();
    profileLinkQuery.mockReturnValue({
      isError: true,
      isFetching: false,
      refetch: refetchLink,
    });
    answer(installable("unknown"));
    render(<IosInstall build={row} device={phone(null)} />);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The check couldn't start")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(refetchLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the console's own path in the profile link", () => {
    window.history.replaceState(null, "", `/console/native-builds/${BUILD}`);
    answer(installable("unknown"));
    render(<IosInstall build={row} device={phone(null)} />);

    expect(link("Check this iPhone")).toBe(
      `/console/_hot-updater/devices/device.mobileconfig?t=${encodeURIComponent(CAPABILITY)}`,
    );
  });

  it("keeps the console's own path in Install", () => {
    window.history.replaceState(null, "", `/console/native-builds/${BUILD}`);
    answer(installable("included"));
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(manifestOf(link("Install"))).toBe(
      `${window.location.origin}/console/_hot-updater/native-builds/${BUILD}/manifest.plist?t=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("offers Install to an iPhone the IPA lists, with the Developer Mode note and the store-app line", () => {
    answer(installable("included"));
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.getByText("In this build")).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenCalledWith(BUILD, PHONE);
    expect(manifestOf(link("Install"))).toContain("/manifest.plist?t=");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(/Developer Mode/)).toBeTruthy();
    expect(screen.getByText(IOS_STORE_APP_NOTE)).toBeTruthy();
  });

  it("asks an iPhone the IPA doesn't list for its name, and requests it with its receipt, never a command", () => {
    answer(installable("not-included"));
    render(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);

    expect(screen.getByText("Not in this build")).toBeTruthy();
    expect(itmsLinks()).toHaveLength(0);
    expect(screen.queryByText(/native-build devices add/)).toBeNull();
    fireEvent.change(screen.getByLabelText("This iPhone's name"), {
      target: { value: "  Kim's iPhone " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(requestAccess.mutate).toHaveBeenCalledWith(
      { receipt: RECEIPT, name: "Kim's iPhone" },
      expect.anything(),
    );
    expect(
      screen.getByText(
        "A maintainer approves it, and it joins the next ad hoc build.",
      ),
    ).toBeTruthy();
  });

  it("shows the request it just made until the page reads the registry again, which then wins, a removal too", () => {
    requestAccess.mutate.mockImplementation(
      (_input: unknown, { onSuccess }: { onSuccess: (r: unknown) => void }) =>
        onSuccess({ device: registryRow(), created: true }),
    );
    answer(installable("not-included"), { dataUpdatedAt: 1 });
    const { rerender } = render(
      <IosInstall build={row} device={phone(PHONE, RECEIPT)} />,
    );
    fireEvent.change(screen.getByLabelText("This iPhone's name"), {
      target: { value: "Kim's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(screen.getByRole("status").textContent).toContain(
      "A maintainer approves it next.",
    );

    // The refreshed eligibility read says a maintainer approved it.
    answer(
      installable(
        "not-included",
        registryRow({ status: "approved", approved_at_ms: 1 }),
      ),
      { dataUpdatedAt: Date.now() + 1000 },
    );
    rerender(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Kim's iPhone is approved. It joins the next ad hoc build.",
    );

    // Then declined: the registry has no row, and Request access returns.
    answer(installable("not-included"), { dataUpdatedAt: Date.now() + 2000 });
    rerender(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);
    expect(screen.getByRole("button", { name: "Request access" })).toBeTruthy();
  });

  it("lets the refresh the request triggers win even when it lands before the request's own answer, as onSettled runs before mutate's onSuccess", () => {
    let complete!: (r: unknown) => void;
    requestAccess.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess: (r: unknown) => void }) => {
        complete = options.onSuccess;
      },
    );
    answer(installable("not-included"), { dataUpdatedAt: 1 });
    const { rerender } = render(
      <IosInstall build={row} device={phone(PHONE, RECEIPT)} />,
    );
    fireEvent.change(screen.getByLabelText("This iPhone's name"), {
      target: { value: "Kim's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    // The real hook awaits invalidateQueries in onSettled, before mutate's onSuccess.
    answer(
      installable(
        "not-included",
        registryRow({ status: "approved", approved_at_ms: 1 }),
      ),
      { dataUpdatedAt: Date.now() - 1 },
    );
    rerender(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);
    act(() => complete({ device: registryRow(), created: true }));
    expect(screen.getByRole("status").textContent).toBe(
      "Kim's iPhone is approved. It joins the next ad hoc build.",
    );
  });

  it("without a receipt, checks the iPhone again before Request access: a link's UDID is never trusted", () => {
    answer(installable("not-included"));
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
    expect(link("Check this iPhone again")).toContain(
      "/_hot-updater/devices/device.mobileconfig?t=",
    );
  });

  it.each([
    [
      "a requested iPhone",
      registryRow(),
      "Kim's iPhone was requested on Nov 11. A maintainer approves it next.",
    ],
    [
      "an approved iPhone",
      registryRow({ status: "approved", approved_at_ms: 1 }),
      "Kim's iPhone is approved. It joins the next ad hoc build.",
    ],
  ])("says where %s stands, with nothing to request", (_, registry, words) => {
    answer(installable("not-included", registry));
    render(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);

    expect(screen.getByRole("status").textContent).toBe(words);
    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
  });

  describe("an iPhone Apple refused", () => {
    const refused = registryRow({
      status: "approved",
      apple_error: "The maximum number of devices was reached.",
    });

    it("shows the refusal as the card's error, Apple's reason alone, and sends an approver to iOS devices", () => {
      answer(installable("not-included", refused, null, true));
      render(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);

      const alert = screen.getByRole("alert");
      expect(
        within(alert).getByText("Apple didn't register this iPhone"),
      ).toBeTruthy();
      expect(
        alert.querySelector("[data-slot=alert-description]")?.textContent,
      ).toBe("The maximum number of devices was reached.");
      expect(link("iOS devices")).toBe("/native-builds/devices");
      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(screen.queryByText(/Ask a maintainer/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Request access" }),
      ).toBeNull();
    });

    it("tells anyone else whom to ask, with no link to a page they can't act on", () => {
      answer(installable("not-included", refused, null, false));
      render(<IosInstall build={row} device={phone(PHONE, RECEIPT)} />);

      expect(screen.getByRole("alert")).toBeTruthy();
      expect(
        screen.getByText("Ask a maintainer to free a device slot."),
      ).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    });

    it("offers the newer build that has it over the refusal", () => {
      const newer = "019a0000-0000-7000-8000-00000000b002";
      answer(installable("not-included", refused, newer, true));
      render(<IosInstall build={row} device={phone(PHONE)} />);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(link("Open the newer build")).toBe(`/native-builds/${newer}`);
    });
  });

  it("opens the newer build that has a registered iPhone", () => {
    const newer = "019a0000-0000-7000-8000-00000000b002";
    answer(
      installable(
        "not-included",
        registryRow({ status: "registered", build_id: newer }),
        newer,
      ),
    );
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.getByRole("status").textContent).toBe(
      "A newer build has Kim's iPhone.",
    );
    expect(link("Open the newer build")).toBe(`/native-builds/${newer}`);
  });

  it("sends a production page to no build the server didn't match, such as the sandbox build that last listed the iPhone", () => {
    // One registry for two schemes: the iPhone was approved, then a sandbox
    // build listed it and became its row's build_id. The server matched that
    // build against this one's app and channel and gave no newer build.
    const sandbox = "019a0000-0000-7000-8000-00000000b002";
    answer(
      installable(
        "not-included",
        registryRow({
          status: "registered",
          registered_at_ms: 1,
          build_id: sandbox,
        }),
        null,
      ),
    );
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Kim's iPhone is registered. It joins the next ad hoc build.",
    );
    expect(
      screen.queryByRole("link", { name: "Open the newer build" }),
    ).toBeNull();
  });

  it.each([
    ["no answer", undefined],
    ["an unavailable IPA", { status: "unavailable" } as const],
  ])(
    "says the details are unavailable for %s, and offers no install",
    (_, data) => {
      installEligibilityQuery.mockReturnValue({
        data,
        isPending: false,
        dataUpdatedAt: 0,
        refetch,
      });
      render(<IosInstall build={row} device={phone(PHONE)} />);

      expect(screen.getByText("Installation details unavailable")).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );

  it("sends an App Store export to TestFlight, with no check or install", () => {
    answer({ status: "store" });
    render(<IosInstall build={row} device={phone(null)} />);

    expect(screen.getByText(/installs through TestFlight/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says an expired profile needs a rebuild, with no install", () => {
    answer({ status: "expired", expiresAt: "2026-01-02T00:00:00.000Z" });
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.getByText(/profile has expired/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names the secret when the Console can't sign the Install link", () => {
    answer({
      status: "installable",
      device: "included",
      registry: null,
      newerBuild: null,
      canApprove: false,
      expiresAt: null,
      link: { status: "no-secret", secretName: "BETTER_AUTH_SECRET" },
    });
    render(<IosInstall build={row} device={phone(PHONE)} />);

    expect(screen.getByRole("status").textContent).toContain(
      "BETTER_AUTH_SECRET",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("an Install link near its expiry", () => {
  const MINUTE = 60_000;
  const OFFERED_FOR = NATIVE_BUILD_INSTALL_LINK_TTL_MS - 5 * MINUTE;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers Install until the link is near its expiry, then takes it away and asks for a new one", () => {
    answer(installable("included"));
    render(<IosInstall build={row} device={phone(PHONE)} />);
    act(() => vi.advanceTimersByTime(OFFERED_FOR - MINUTE));
    expect(itmsLinks()).toHaveLength(1);
    expect(refetch).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(MINUTE));

    expect(itmsLinks()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("expired");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it.each(["visibilitychange", "pageshow"])(
    "takes the link away on %s after the phone slept, when no timer ran",
    (event) => {
      answer(installable("included"));
      render(<IosInstall build={row} device={phone(PHONE)} />);

      vi.setSystemTime(Date.now() + 2 * NATIVE_BUILD_INSTALL_LINK_TTL_MS);
      expect(itmsLinks()).toHaveLength(1);
      act(() => {
        (event === "pageshow" ? window : document).dispatchEvent(
          new Event(event),
        );
      });

      expect(itmsLinks()).toHaveLength(0);
      expect(refetch).toHaveBeenCalledTimes(1);
    },
  );

  it("never shows a dead link while the new one loads, or after it fails", () => {
    const readAt = Date.now();
    answer(installable("included"), {
      dataUpdatedAt: readAt,
      isFetching: true,
    });
    const view = render(<IosInstall build={row} device={phone(PHONE)} />);
    act(() => vi.advanceTimersByTime(OFFERED_FOR));
    expect(itmsLinks()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Getting a new one",
    );
    expect(screen.queryByRole("button")).toBeNull();

    // A failed refresh keeps the old data and when it was read.
    answer(installable("included"), { dataUpdatedAt: readAt });
    view.rerender(<IosInstall build={row} device={phone(PHONE)} />);
    expect(itmsLinks()).toHaveLength(0);
    refetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("offers Install again once a new link arrives", () => {
    const readAt = Date.now();
    answer(installable("included"), { dataUpdatedAt: readAt });
    const view = render(<IosInstall build={row} device={phone(PHONE)} />);
    act(() => vi.advanceTimersByTime(OFFERED_FOR));
    expect(itmsLinks()).toHaveLength(0);

    answer(installable("included"));
    view.rerender(<IosInstall build={row} device={phone(PHONE)} />);

    expect(itmsLinks()).toHaveLength(1);
  });

  it.each(["unknown", "not-included"] as const)(
    "keeps no install link to renew for %s",
    (device) => {
      answer(installable(device));
      render(
        <IosInstall
          build={row}
          device={phone(device === "unknown" ? null : PHONE)}
        />,
      );
      act(() => vi.advanceTimersByTime(OFFERED_FOR));

      expect(refetch).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("asks for nothing for an IPA with no link to expire", () => {
    answer({ status: "store" });
    render(<IosInstall build={row} device={phone(PHONE)} />);
    act(() => vi.advanceTimersByTime(2 * NATIVE_BUILD_INSTALL_LINK_TTL_MS));
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe("InstallCard on an iPhone", () => {
  const onIphone = () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    downloadLinkQuery.mockReturnValue({
      data: {
        status: "issued",
        token: TOKEN,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
  };

  afterEach(() => vi.restoreAllMocks());

  it("shows the install flow alone, with the computer's ways closed under it", async () => {
    onIphone();
    answer(installable("unknown"));
    render(<InstallCard build={row} />);

    expect(
      await screen.findByRole("link", { name: "Check this iPhone" }),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Download App\.ipa/ }),
    ).toBeNull();
    expect(
      screen.getByText(/npx hot-updater testflight/).closest("[hidden]"),
    ).not.toBeNull();

    const other = screen.getByRole("button", { name: "Other ways to install" });
    expect(other.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(other);
    expect(other.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("link", { name: /Download App\.ipa/ }),
    ).toBeTruthy();
  });

  it("keeps the computer's ways open on a computer, beside the QR code", () => {
    downloadLinkQuery.mockReturnValue({
      data: {
        status: "issued",
        token: TOKEN,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    render(<InstallCard build={row} />);

    expect(
      screen.queryByRole("button", { name: "Other ways to install" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: /Download App\.ipa/ }),
    ).toBeTruthy();
  });

  it("passes the UDID this phone kept", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, PHONE);
    onIphone();
    answer(installable("included"));
    render(<InstallCard build={row} />);

    expect(await screen.findByRole("link", { name: "Install" })).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenCalledWith(BUILD, PHONE);
  });

  it("offers Install once another tab keeps the profile's answer", async () => {
    onIphone();
    installEligibilityQuery.mockImplementation(
      (_: string, udid: string | null) => ({
        isPending: false,
        isFetching: false,
        dataUpdatedAt: Date.now(),
        refetch,
        data: installable(udid === null ? "unknown" : "included"),
      }),
    );
    render(<InstallCard build={row} />);
    await screen.findByRole("link", { name: "Check this iPhone" });

    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, PHONE);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: IOS_UDID_STORAGE_KEY }),
      );
    });

    expect(await screen.findByRole("link", { name: "Install" })).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE);
  });

  it("uses the ID the profile's page passes in the fragment where nothing is kept, and drops it", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    window.history.replaceState(
      null,
      "",
      `/native-builds/${BUILD}#udid=${PHONE}`,
    );
    onIphone();
    answer(installable("included"));
    render(<InstallCard build={row} />);

    expect(await screen.findByRole("link", { name: "Install" })).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE);
    expect(window.location.hash).toBe("");
  });

  it("takes the check's answer when Safari returns to this tab already open, which changes only the fragment", async () => {
    onIphone();
    answer(installable("unknown"));
    render(<InstallCard build={row} />);
    expect(
      await screen.findByRole("link", { name: "Check this iPhone" }),
    ).toBeTruthy();

    act(() => {
      window.history.replaceState(
        null,
        "",
        `/native-builds/${BUILD}#udid=${PHONE}&r=${RECEIPT}`,
      );
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await vi.waitFor(() =>
      expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE),
    );
    expect(window.localStorage.getItem(IOS_UDID_STORAGE_KEY)).toBe(PHONE);
    expect(window.location.hash).toBe("");
  });

  it("keeps the fragment's ID when React runs the effect twice, as its development check does", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    window.history.replaceState(
      null,
      "",
      `/native-builds/${BUILD}#udid=${PHONE}`,
    );
    onIphone();
    answer(installable("included"));
    render(
      <StrictMode>
        <InstallCard build={row} />
      </StrictMode>,
    );

    expect(await screen.findByRole("link", { name: "Install" })).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE);
  });

  it("prefers the ID this phone kept over one a link carries", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, PHONE);
    window.history.replaceState(
      null,
      "",
      `/native-builds/${BUILD}#udid=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`,
    );
    onIphone();
    answer(installable("included"));
    render(<InstallCard build={row} />);

    await screen.findByRole("link", { name: "Install" });
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE);
  });

  it("ignores text in that key that isn't a UDID", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, "<script>");
    onIphone();
    answer(installable("unknown"));
    render(<InstallCard build={row} />);

    await screen.findByRole("link", { name: "Check this iPhone" });
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, null);
  });

  it("reads nothing about an IPA for a build a store took", () => {
    onIphone();
    render(
      <InstallCard
        build={
          {
            ...row,
            submitted_to: "testflight",
            submitted_at_ms: 1,
          } as NativeBuildRow
        }
      />,
    );
    expect(installEligibilityQuery).not.toHaveBeenCalled();
  });

  it("keeps the profile's UDID, trades its receipt for the cookie, and keeps no receipt where script reads it", async () => {
    window.localStorage.setItem(
      IOS_UDID_STORAGE_KEY,
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    );
    // What an earlier version kept goes.
    window.localStorage.setItem(
      IOS_DEVICE_RECEIPT_STORAGE_KEY,
      JSON.stringify({ udid: PHONE, receipt: "old" }),
    );
    window.history.replaceState(
      null,
      "",
      `/native-builds/${BUILD}#udid=${PHONE}&r=${RECEIPT}`,
    );
    onIphone();
    answer(installable("not-included"));
    render(<InstallCard build={row} />);

    expect(
      await screen.findByRole("button", { name: "Request access" }),
    ).toBeTruthy();
    expect(installEligibilityQuery).toHaveBeenLastCalledWith(BUILD, PHONE);
    expect(window.localStorage.getItem(IOS_UDID_STORAGE_KEY)).toBe(PHONE);
    expect(window.localStorage.getItem(IOS_DEVICE_RECEIPT_STORAGE_KEY)).toBe(
      null,
    );
    // The fragment's receipt goes to the trade, which sets the cookie.
    expect(keepReceipt).toHaveBeenCalledWith("", RECEIPT);
    expect(keptQuery).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ udid: PHONE, receipt: RECEIPT }),
      true,
    );
    expect(window.location.hash).toBe("");
  });

  it("keeps the proof as the cookie whatever the page shows next, such as an iPhone already in the build", async () => {
    window.history.replaceState(
      null,
      "",
      `/console/native-builds/${BUILD}#udid=${PHONE}&r=${RECEIPT}`,
    );
    onIphone();
    answer(installable("included"));
    render(<InstallCard build={row} />);

    expect(await screen.findByRole("link", { name: "Install" })).toBeTruthy();
    // Under the Console's own path.
    expect(keepReceipt).toHaveBeenCalledWith("/console", RECEIPT);
  });

  it("requests again after a reload with no profile, from the cookie an earlier check left", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, PHONE);
    keptQuery.mockReturnValue({
      data: { udid: PHONE.toLowerCase() },
      isPending: false,
    });
    onIphone();
    answer(installable("not-included"));
    render(<InstallCard build={row} />);

    fireEvent.change(await screen.findByLabelText("This iPhone's name"), {
      target: { value: "Kim's iPhone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(requestAccess.mutate).toHaveBeenCalledWith(
      { receipt: null, name: "Kim's iPhone" },
      expect.anything(),
    );
    expect(
      screen.queryByRole("link", { name: "Check this iPhone again" }),
    ).toBeNull();
  });

  it("asks for the profile again when the cookie proves another iPhone, or none", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, PHONE);
    keptQuery.mockReturnValue({
      data: { udid: "00008110-001a2b3c4d5e6f70" },
      isPending: false,
    });
    onIphone();
    answer(installable("not-included"));
    render(<InstallCard build={row} />);

    expect(
      await screen.findByRole("link", { name: "Check this iPhone again" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request access" })).toBeNull();
  });
});

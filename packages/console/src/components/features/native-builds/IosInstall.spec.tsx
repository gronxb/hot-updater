import type { NativeBuildRow } from "@hot-updater/plugin-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IOS_UDID_STORAGE_KEY,
  NATIVE_BUILD_INSTALL_LINK_TTL_MS,
} from "@/lib/native-builds";
import type { NativeBuildInstallEligibility } from "@/lib/server/nativeBuildInstall";

import { InstallCard } from "./InstallCard";
import { IOS_STORE_APP_NOTE, IosInstall, isIosBrowser } from "./IosInstall";

const { downloadLinkQuery, downloadUrlQuery, installEligibilityQuery } =
  vi.hoisted(() => ({
    downloadLinkQuery: vi.fn(),
    downloadUrlQuery: vi.fn(),
    installEligibilityQuery: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  useNativeBuildDownloadLinkQuery: downloadLinkQuery,
  useNativeBuildDownloadUrlQuery: downloadUrlQuery,
  useNativeBuildInstallEligibilityQuery: installEligibilityQuery,
}));

const BUILD = "019a0000-0000-7000-8000-00000000b001";
const PHONE = "00008030-001C2D3E4F5A6B7C";
const TOKEN = "1893456000.signature";
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
): NativeBuildInstallEligibility => ({
  status: "installable",
  device,
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

beforeEach(() => {
  vi.clearAllMocks();
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
    render(<IosInstall build={row} udid={null} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByLabelText("Reading this IPA")).toBeTruthy();
  });

  it("offers an unknown iPhone the check first, and Install anyway second", () => {
    answer(installable("unknown"));
    render(<IosInstall build={row} udid={null} />);

    expect(link(/Check this iPhone/)).toBe(
      `/_hot-updater/native-builds/${BUILD}/device.mobileconfig`,
    );
    expect(manifestOf(link("Install anyway"))).toBe(
      `${window.location.origin}/_hot-updater/native-builds/${BUILD}/manifest.plist?t=${encodeURIComponent(TOKEN)}`,
    );
    expect(screen.queryByRole("link", { name: "Install" })).toBeNull();
    const check = screen.getByRole("link", { name: /Check this iPhone/ });
    expect(
      check.compareDocumentPosition(
        screen.getByRole("link", { name: "Install anyway" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the console's own path in both links", () => {
    window.history.replaceState(null, "", `/console/native-builds/${BUILD}`);
    answer(installable("unknown"));
    render(<IosInstall build={row} udid={null} />);

    expect(link(/Check this iPhone/)).toBe(
      `/console/_hot-updater/native-builds/${BUILD}/device.mobileconfig`,
    );
    expect(manifestOf(link("Install anyway"))).toContain(
      `/console/_hot-updater/native-builds/${BUILD}/manifest.plist?t=`,
    );
  });

  it("offers Install to an iPhone the IPA lists, with the Developer Mode note and the store-app line", () => {
    answer(installable("included"));
    render(<IosInstall build={row} udid={PHONE} />);

    expect(installEligibilityQuery).toHaveBeenCalledWith(BUILD, PHONE);
    expect(manifestOf(link("Install"))).toContain("/manifest.plist?t=");
    expect(screen.queryByRole("link", { name: "Install anyway" })).toBeNull();
    expect(screen.getByText(/Developer Mode/)).toBeTruthy();
    expect(screen.getByText(IOS_STORE_APP_NOTE)).toBeTruthy();
  });

  it("says Not in this build to an iPhone it doesn't list, with the command and Install anyway second", () => {
    answer(installable("not-included"));
    render(<IosInstall build={row} udid={PHONE} />);

    expect(screen.getByText("Not in this build")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Install" })).toBeNull();
    expect(screen.getByRole("link", { name: "Install anyway" })).toBeTruthy();
    expect(
      screen.getByText(
        `npx hot-updater native-build devices add --udid ${PHONE} --name "Teammate's iPhone"`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/only\s+if this is your iPhone/u)).toBeTruthy();
    expect(screen.getByText(/Developer Mode/)).toBeTruthy();
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
      render(<IosInstall build={row} udid={PHONE} />);

      expect(screen.getByText("Installation details unavailable")).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );

  it("sends an App Store export to TestFlight, with no check or install", () => {
    answer({ status: "store" });
    render(<IosInstall build={row} udid={null} />);

    expect(screen.getByText(/installs through TestFlight/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says an expired profile needs a rebuild, with no install", () => {
    answer({ status: "expired", expiresAt: "2026-01-02T00:00:00.000Z" });
    render(<IosInstall build={row} udid={PHONE} />);

    expect(screen.getByText(/profile has expired/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names the secret when the Console can't sign the Install link", () => {
    answer({
      status: "installable",
      device: "included",
      expiresAt: null,
      link: { status: "no-secret", secretName: "BETTER_AUTH_SECRET" },
    });
    render(<IosInstall build={row} udid={PHONE} />);

    expect(screen.getByRole("status").textContent).toContain(
      "BETTER_AUTH_SECRET",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("an Install link near its expiry", () => {
  const MINUTE = 60_000;
  const OFFERED_FOR = NATIVE_BUILD_INSTALL_LINK_TTL_MS - 5 * MINUTE;
  const itmsLinks = () =>
    screen
      .queryAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("itms-services:"));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers Install until the link is near its expiry, then takes it away and asks for a new one", () => {
    answer(installable("included"));
    render(<IosInstall build={row} udid={PHONE} />);
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
      render(<IosInstall build={row} udid={PHONE} />);

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
    const view = render(<IosInstall build={row} udid={PHONE} />);
    act(() => vi.advanceTimersByTime(OFFERED_FOR));
    expect(itmsLinks()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain(
      "Getting a new one",
    );
    expect(screen.queryByRole("button")).toBeNull();

    // A failed refresh keeps the old data and when it was read.
    answer(installable("included"), { dataUpdatedAt: readAt });
    view.rerender(<IosInstall build={row} udid={PHONE} />);
    expect(itmsLinks()).toHaveLength(0);
    refetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("offers Install again once a new link arrives", () => {
    const readAt = Date.now();
    answer(installable("included"), { dataUpdatedAt: readAt });
    const view = render(<IosInstall build={row} udid={PHONE} />);
    act(() => vi.advanceTimersByTime(OFFERED_FOR));
    expect(itmsLinks()).toHaveLength(0);

    answer(installable("included"));
    view.rerender(<IosInstall build={row} udid={PHONE} />);

    expect(itmsLinks()).toHaveLength(1);
  });

  it.each(["unknown", "not-included"] as const)(
    "takes Install anyway away for %s too, keeping the rest of the page",
    (device) => {
      answer(installable(device));
      render(
        <IosInstall build={row} udid={device === "unknown" ? null : PHONE} />,
      );
      act(() => vi.advanceTimersByTime(OFFERED_FOR));

      expect(itmsLinks()).toHaveLength(0);
      expect(screen.getByRole("status").textContent).toContain("expired");
    },
  );

  it("asks for nothing for an IPA with no link to expire", () => {
    answer({ status: "store" });
    render(<IosInstall build={row} udid={PHONE} />);
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

  it("shows the install flow instead of a QR code, and keeps the download", async () => {
    onIphone();
    answer(installable("unknown"));
    render(<InstallCard build={row} />);

    expect(
      await screen.findByRole("link", { name: /Check this iPhone/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
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

  it("ignores text in that key that isn't a UDID", async () => {
    window.localStorage.setItem(IOS_UDID_STORAGE_KEY, "<script>");
    onIphone();
    answer(installable("unknown"));
    render(<InstallCard build={row} />);

    await screen.findByRole("link", { name: /Check this iPhone/ });
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
});

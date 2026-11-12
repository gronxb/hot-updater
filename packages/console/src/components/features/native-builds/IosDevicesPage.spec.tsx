import type { IosDeviceRow } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IosDevicesView } from "@/lib/ios-devices-rpc";

const {
  devicesQuery,
  deviceQuery,
  keptQuery,
  again,
  profileLinkQuery,
  approve,
  rename,
  remove,
} = vi.hoisted(() => {
  const mutation = () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  });
  return {
    devicesQuery: vi.fn(),
    deviceQuery: vi.fn(),
    keptQuery: vi.fn(),
    again: mutation(),
    profileLinkQuery: vi.fn(),
    approve: mutation(),
    rename: mutation(),
    remove: mutation(),
  };
});

vi.mock("@/lib/ios-devices-api", async (importOriginal) => ({
  keptIsThisIphone: (
    await importOriginal<typeof import("@/lib/ios-devices-api")>()
  ).keptIsThisIphone,
  useKeptIosDeviceQuery: keptQuery,
  keepIosDeviceReceipt: vi.fn(async () => null),
  useRequestThisIphoneMutation: () => again,
  iosDeviceKeys: { all: ["ios-devices"] },
  useIosDevicesQuery: devicesQuery,
  useIosDeviceQuery: deviceQuery,
  useIosDeviceProfileLinkQuery: profileLinkQuery,
  useApproveIosDeviceMutation: () => approve,
  useRenameIosDeviceMutation: () => rename,
  useRemoveIosDeviceMutation: () => remove,
}));
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));
const { mobile } = vi.hoisted(() => ({ mobile: { value: false } }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
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
    <a href={params ? to.replace("$buildId", params.buildId) : to} {...props}>
      {children as never}
    </a>
  ),
}));

import { IosDevicesPage } from "./IosDevicesPage";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const device = (overrides: Partial<IosDeviceRow> = {}): IosDeviceRow => ({
  id: "01a1c984-724b-7de1-89a1-c93003b4ff49",
  udid: "00008030-001c2d3e4f5a6b7c",
  name: "Kim's iPhone",
  status: "pending",
  requested_by: "kim@team.dev",
  created_at_ms: Date.now() - 60_000,
  approved_by: null,
  approved_at_ms: null,
  registered_at_ms: null,
  apple_issuer_id: null,
  apple_error: null,
  build_id: null,
  ...overrides,
});

const viewAs = (
  viewer: Partial<IosDevicesView["viewer"]>,
  devices: IosDeviceRow[],
): IosDevicesView => ({
  devices,
  viewer: {
    email: "lead@team.dev",
    canApprove: true,
    approversConfigured: true,
    ...viewer,
  },
  defaultName: "Lead's iPhone",
  registration: "ready",
  secretName: "BETTER_AUTH_SECRET",
});

const show = (view: IosDevicesView, search = {}) => {
  devicesQuery.mockReturnValue({
    data: view,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });
  const onSearchChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IosDevicesPage onSearchChange={onSearchChange} search={search} />
    </QueryClientProvider>,
  );
  return { onSearchChange };
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  keptQuery.mockReturnValue({
    data: { udid: null },
    isPending: false,
    isFetching: false,
  });
  deviceQuery.mockReturnValue({
    data: undefined,
    isPending: true,
    refetch: vi.fn(),
  });
  profileLinkQuery.mockReturnValue({
    data: { status: "issued", token: "cap.sig", expiresAt: "2030-01-01" },
  });
  window.history.replaceState(null, "", "/native-builds/devices");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IosDevicesPage", () => {
  it("lives in Native builds, beside Builds, with no menu of its own", () => {
    show(viewAs({}, []));
    const nav = screen.getByRole("navigation", { name: "Native builds views" });
    expect(within(nav).getByRole("link", { name: "Builds" })).toBeTruthy();
    expect(
      within(nav)
        .getByRole("link", { name: "iOS devices" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Native builds",
    );
  });

  it("shows a computer the QR code of this page, and an empty list its next step", () => {
    show(viewAs({}, []));
    expect(
      screen.getByRole("img", { name: "Open this page on an iPhone" }),
    ).toBeTruthy();
    expect(screen.getByText("No iPhones yet")).toBeTruthy();
    expect(
      screen.getByText("Open this page on an iPhone to register it."),
    ).toBeTruthy();
    expect(profileLinkQuery).toHaveBeenCalledWith(
      { mode: "register", name: "Lead's iPhone" },
      false,
    );
  });

  it("gives an iPhone its name and the profile, signed for the person", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    const location = window.location;
    Object.defineProperty(window, "location", {
      value: new URL("https://console.example.com/native-builds/devices"),
      configurable: true,
    });
    try {
      show(viewAs({}, []));
      expect(
        (screen.getByLabelText("This iPhone's name") as HTMLInputElement).value,
      ).toBe("Lead's iPhone");
      expect(
        screen
          .getByRole("link", { name: "Install profile" })
          .getAttribute("href"),
      ).toBe("/_hot-updater/devices/device.mobileconfig?t=cap.sig");
    } finally {
      // The real Location, so later specs see history's changes.
      Object.defineProperty(window, "location", {
        value: location,
        configurable: true,
      });
    }
  });

  it("lets an approver approve with the slot's cost in view, naming the device", () => {
    show(viewAs({}, [device()]));
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Requested")).toBeTruthy();
    expect(within(row).getByText("…5a6b7c")).toBeTruthy();
    expect(within(row).queryByText("00008030-001c2d3e4f5a6b7c")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        /Each new iPhone uses one of the account's 100 a year, and removing it never gives the slot back\./,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("kim@team.dev")).toBeTruthy();
    // The whole UDID, to check against the device: a phone never hovers.
    const udid = within(dialog).getByText("00008030-001c2d3e4f5a6b7c");
    expect(udid.className).toContain("select-all");
    expect(udid.className).toContain("font-mono");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Kim's work iPhone" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(approve.mutate).toHaveBeenCalledWith(
      { id: device().id, name: "Kim's work iPhone" },
      expect.anything(),
    );
  });

  it("gives a requester Withdraw on their own request, and nobody else any action", () => {
    show(
      viewAs({ email: "kim@team.dev", canApprove: false }, [
        device(),
        device({
          id: "01a1c984-724b-7de1-89a1-c93003b4ff50",
          udid: "a".repeat(40),
          name: "Lee's iPad",
          requested_by: "lee@team.dev",
        }),
      ]),
    );
    const own = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(own).getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(within(own).queryByRole("button", { name: "Approve" })).toBeNull();
    const other = screen.getByRole("row", { name: /Lee's iPad/ });
    expect(within(other).queryAllByRole("button")).toEqual([]);
  });

  it("says in one line that a removed device stays in builds until Apple disables it, with no command for the action", () => {
    show(
      viewAs({}, [
        device({
          status: "registered",
          approved_at_ms: 1,
          registered_at_ms: 2,
        }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    fireEvent.click(
      within(row).getByRole("button", {
        name: "More actions for Kim's iPhone",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(
        "It leaves the list. New ad hoc builds keep it until it's disabled at Apple.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/membership year/)).toBeNull();
    // The Console removes it: no command stands beside the button.
    expect(within(dialog).queryByText(/npx hot-updater/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Copy/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(remove.mutate).toHaveBeenCalledWith(
      { udid: "00008030-001c2d3e4f5a6b7c" },
      expect.anything(),
    );
  });

  it("marks Apple's refusal of an approved device with a warning in place of Approved, its reason under it", () => {
    show(
      viewAs({}, [
        device({
          status: "approved",
          approved_at_ms: 1,
          apple_error: "The maximum number of devices was reached.",
        }),
        device({
          id: "01a1c984-724b-7de1-89a1-c93003b4ff50",
          udid: "a".repeat(40),
          name: "Lee's iPad",
          status: "approved",
          approved_at_ms: 1,
        }),
      ]),
    );
    const refused = screen.getByRole("row", { name: /Kim's iPhone/ });
    const badge = within(refused).getByText("Apple refused");
    expect(badge.getAttribute("data-variant")).toBe("warning");
    expect(within(refused).queryByText("Approved")).toBeNull();
    // At most two lines in a narrow column, so a long reason never widens the
    // table past its frame; the full text stays in the row and on hover.
    const reason = within(refused).getByText(
      "The maximum number of devices was reached.",
    );
    expect(reason.className).toContain("line-clamp-2");
    expect(reason.className).toContain("max-w-48");
    expect(reason.getAttribute("title")).toBe(
      "The maximum number of devices was reached.",
    );
    const approved = screen.getByRole("row", { name: /Lee's iPad/ });
    expect(
      within(approved).getByText("Approved").getAttribute("data-variant"),
    ).toBe("secondary");
  });

  it("shows a phone the whole reason on the card, unclamped", () => {
    mobile.value = true;
    try {
      show(
        viewAs({}, [
          device({
            status: "approved",
            approved_at_ms: 1,
            apple_error:
              "An invalid value was provided for UDID (QA staged on a fake row).",
          }),
        ]),
      );
      const reason = within(
        screen.getByRole("list", { name: "iOS devices" }),
      ).getByText(
        "An invalid value was provided for UDID (QA staged on a fake row).",
      );
      expect(reason.className).not.toContain("line-clamp");
    } finally {
      mobile.value = false;
    }
  });

  it("names a device the CLI added as added from a terminal, and shows a device with no build as -", () => {
    show(
      viewAs({}, [
        device({ requested_by: null, status: "approved", approved_at_ms: 1 }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Added from a terminal")).toBeTruthy();
    expect(within(row).getByText("-")).toBeTruthy();
    expect(within(row).queryByText("—")).toBeNull();
  });

  it("shows Apple's reason under a registered device's status, and the build that lists a device", () => {
    show(
      viewAs({}, [
        device({
          status: "registered",
          apple_error: "Disabled in the Apple account.",
          build_id: "01a1c997-60fe-7475-bd6c-3a90777fe9f3",
        }),
      ]),
    );
    const row = screen.getByRole("row", { name: /Kim's iPhone/ });
    expect(within(row).getByText("Registered")).toBeTruthy();
    expect(
      within(row).getByText("Disabled in the Apple account."),
    ).toBeTruthy();
    expect(
      within(row)
        .getByRole("link", { name: /Build of/ })
        .getAttribute("href"),
    ).toBe("/native-builds/01a1c997-60fe-7475-bd6c-3a90777fe9f3");
  });

  it("shows no QR code on the local Console, which an iPhone can't reach", () => {
    show({ ...viewAs({}, []), registration: "local-console" });
    expect(screen.queryByRole("img", { name: /iPhone/ })).toBeNull();
    expect(
      screen.getByText(/iPhones register through your hosted Console/),
    ).toBeTruthy();
  });

  it("points to the terminal when nobody approves in this Console", () => {
    show(viewAs({ canApprove: false, approversConfigured: false }, []));
    expect(
      screen.getByText("npx hot-updater native-build devices add"),
    ).toBeTruthy();
  });

  it("filters by status in the URL, and an empty filter offers Show all", () => {
    const { onSearchChange } = show(viewAs({}, []), { status: "approved" });
    expect(devicesQuery).toHaveBeenCalledWith("approved");
    expect(screen.getByText("No approved iPhones")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onSearchChange).toHaveBeenCalledWith({});
  });

  describe("this iPhone, back from its profile", () => {
    const PHONE = "00008160-000239A910A3400A";
    const mine = (overrides: Partial<IosDeviceRow> = {}) =>
      device({
        udid: PHONE.toLowerCase(),
        name: "Sungyu Kang's iPhone",
        requested_by: "lead@team.dev",
        ...overrides,
      });
    /** The registry's row of this iPhone, as the single read answers. */
    const refetchMine = vi.fn();
    const registryHas = (row: IosDeviceRow | null) =>
      deviceQuery.mockImplementation((udid: string | null) =>
        udid?.toLowerCase() === PHONE.toLowerCase()
          ? { data: row, isPending: false, refetch: refetchMine }
          : { data: undefined, isPending: udid !== null, refetch: refetchMine },
      );
    const onIphone = () =>
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    const card = () =>
      screen
        .getByRole("heading", { name: "Register an iPhone" })
        .closest("[data-slot=card]") as HTMLElement;

    it("shows the request in place of the form after a reload, from the ID this phone kept", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(mine());
      show(viewAs({ canApprove: false, email: "kim@team.dev" }, [mine()]));

      expect(
        await within(card()).findByText("Sungyu Kang's iPhone"),
      ).toBeTruthy();
      expect(within(card()).getByText("Requested")).toBeTruthy();
      expect(
        within(card()).getByText("A maintainer approves it next."),
      ).toBeTruthy();
      expect(
        within(card()).queryByRole("link", { name: "Install profile" }),
      ).toBeNull();
      expect(within(card()).queryByLabelText("This iPhone's name")).toBeNull();
    });

    it("takes the answer when Safari returns to this same tab, which changes only the fragment", async () => {
      onIphone();
      registryHas(mine());
      show(viewAs({}, [mine()]));
      // The registration flow, which over this test's HTTP asks for HTTPS.
      expect(
        await within(card()).findByText("iPhones need this Console on HTTPS."),
      ).toBeTruthy();

      act(() => {
        window.history.replaceState(
          null,
          "",
          `/native-builds/devices#udid=${PHONE}&requested=1`,
        );
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

      expect(await within(card()).findByText("Requested")).toBeTruthy();
      expect(
        within(card()).queryByText("iPhones need this Console on HTTPS."),
      ).toBeNull();
      expect(window.localStorage.getItem("hot-updater-ios-udid")).toBe(PHONE);
      expect(window.location.hash).toBe("");
    });

    it("shows the row when the profile's answer opens a new tab, for an iPhone the registry already had", async () => {
      // Approved on an earlier visit; this phone kept nothing, so it ran the
      // profile again, and the answer opens the page with its fragment.
      onIphone();
      window.history.replaceState(
        null,
        "",
        `/native-builds/devices#udid=${PHONE}&requested=1`,
      );
      const approved = mine({ status: "approved", approved_at_ms: 1 });
      registryHas(approved);
      show(viewAs({ canApprove: false, email: "kim@team.dev" }, [approved]));

      expect(await within(card()).findByText("Approved")).toBeTruthy();
      expect(
        within(card()).getByText("It joins the next ad hoc build."),
      ).toBeTruthy();
      expect(window.localStorage.getItem("hot-updater-ios-udid")).toBe(PHONE);
      expect(window.location.hash).toBe("");
    });

    it("reads its row again when an answer with the same ID returns to this tab, as a removed iPhone registering again does", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(null);
      show(viewAs({}, []));
      await within(card()).findByText("iPhones need this Console on HTTPS.");
      refetchMine.mockClear();

      act(() => {
        window.history.replaceState(
          null,
          "",
          `/native-builds/devices#udid=${PHONE}&requested=1`,
        );
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

      expect(refetchMine).toHaveBeenCalled();
    });

    it("gives an approver Apple's refusal with no step of its own: the row is in the list below", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      const refused = mine({
        status: "approved",
        approved_at_ms: 1,
        apple_error: "The maximum number of devices was reached.",
      });
      registryHas(refused);
      show(viewAs({}, [refused]));

      expect(await within(card()).findByRole("alert")).toBeTruthy();
      expect(within(card()).queryByText(/Ask a maintainer/)).toBeNull();
      expect(within(card()).queryByRole("link")).toBeNull();
    });

    it("points an approver to this iPhone's row, which alone carries Approve, tagged This iPhone", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(mine());
      show(viewAs({}, [mine(), device()]));

      expect(
        await within(card()).findByText(
          "Approve it below, and it joins the next ad hoc build.",
        ),
      ).toBeTruthy();
      expect(within(card()).queryByRole("button")).toBeNull();
      // The table: one Approve per request, this iPhone's tagged.
      expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(
        2,
      );
      const mineRow = screen.getByRole("row", { name: /Sungyu Kang's iPhone/ });
      expect(within(mineRow).getByText("This iPhone")).toBeTruthy();
      const other = screen.getByRole("row", { name: /^Kim's iPhone/ });
      expect(within(other).queryByText("This iPhone")).toBeNull();
      fireEvent.click(within(mineRow).getByRole("button", { name: "Approve" }));
      expect(
        within(screen.getByRole("dialog")).getByText(
          /Approve Sungyu Kang's iPhone\?/,
        ),
      ).toBeTruthy();
    });

    it("tags this iPhone's card in the phone's list too, with its actions there", async () => {
      onIphone();
      mobile.value = true;
      try {
        window.localStorage.setItem("hot-updater-ios-udid", PHONE);
        registryHas(mine());
        show(viewAs({}, [mine()]));

        await within(card()).findByText(
          "Approve it below, and it joins the next ad hoc build.",
        );
        const item = within(
          screen.getByRole("list", { name: "iOS devices" }),
        ).getByRole("listitem");
        expect(within(item).getByText("This iPhone")).toBeTruthy();
        expect(
          within(item).getByRole("button", { name: "Approve" }),
        ).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(
          1,
        );
      } finally {
        mobile.value = false;
      }
    });

    it("tags no row on a computer, whatever it kept", () => {
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(mine());
      show(viewAs({}, [mine()]));

      expect(screen.queryByText("This iPhone")).toBeNull();
    });

    it.each([
      [
        "approved",
        mine({ status: "approved", approved_at_ms: 1 }),
        "Approved",
        "It joins the next ad hoc build.",
      ],
      [
        "registered",
        mine({ status: "registered", approved_at_ms: 1, registered_at_ms: 2 }),
        "Registered",
        "New ad hoc builds install on it.",
      ],
    ])(
      "says where an %s iPhone stands, with no form",
      async (_, row, badge, words) => {
        onIphone();
        window.localStorage.setItem("hot-updater-ios-udid", PHONE);
        registryHas(row);
        show(viewAs({ canApprove: false, email: "kim@team.dev" }, [row]));

        expect(await within(card()).findByText(badge)).toBeTruthy();
        expect(within(card()).getByText(words)).toBeTruthy();
        expect(
          within(card()).queryByRole("button", { name: "Approve" }),
        ).toBeNull();
        expect(
          within(card()).queryByLabelText("This iPhone's name"),
        ).toBeNull();
      },
    );

    it("shows Apple's refusal as #1878 does, with whom to ask", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      const refused = mine({
        status: "approved",
        approved_at_ms: 1,
        apple_error: "The maximum number of devices was reached.",
      });
      registryHas(refused);
      show(viewAs({ canApprove: false, email: "kim@team.dev" }, [refused]));

      const alert = await within(card()).findByRole("alert");
      expect(
        within(alert).getByText("Apple didn't register this iPhone"),
      ).toBeTruthy();
      expect(
        within(alert).getByText("The maximum number of devices was reached."),
      ).toBeTruthy();
      expect(
        within(card()).getByText("Ask a maintainer to free a device slot."),
      ).toBeTruthy();
    });

    it("offers the form again once its row was removed", async () => {
      onIphone();
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(null);
      show(viewAs({}, []));

      // The registration flow, which over this test's HTTP asks for HTTPS.
      expect(
        await within(card()).findByText("iPhones need this Console on HTTPS."),
      ).toBeTruthy();
      expect(within(card()).queryByText("Requested")).toBeNull();
    });

    /** Renders on HTTPS, where Safari keeps the Secure cookie. */
    const onHttps =
      (run: () => void | Promise<void>, hash = "") =>
      async () => {
        const location = window.location;
        Object.defineProperty(window, "location", {
          value: new URL(
            `https://console.example.com/native-builds/devices${hash}`,
          ),
          configurable: true,
        });
        try {
          await run();
        } finally {
          Object.defineProperty(window, "location", {
            value: location,
            configurable: true,
          });
        }
      };

    it(
      "requests this iPhone again after its row was removed, from the cookie, with no profile",
      onHttps(async () => {
        onIphone();
        window.localStorage.setItem("hot-updater-ios-udid", PHONE);
        registryHas(null);
        keptQuery.mockReturnValue({
          data: { udid: PHONE.toLowerCase() },
          isPending: false,
          isFetching: false,
        });
        show(viewAs({ canApprove: false, email: "kim@team.dev" }, []));

        const request = await within(card()).findByRole("button", {
          name: "Request this iPhone",
        });
        expect(
          within(card()).queryByRole("link", { name: "Install profile" }),
        ).toBeNull();
        fireEvent.change(within(card()).getByLabelText("This iPhone's name"), {
          target: { value: "Kim's iPhone" },
        });
        fireEvent.click(request);
        expect(again.mutate).toHaveBeenCalledWith({
          name: "Kim's iPhone",
          receipt: null,
        });
      }),
    );

    it(
      "takes this iPhone's identity from the cookie when Safari wiped its storage, and offers Request this iPhone, not the profile",
      onHttps(async () => {
        onIphone();
        // ITP cleared script storage; the 30-day HttpOnly cookie remains.
        registryHas(null);
        keptQuery.mockReturnValue({
          data: { udid: PHONE.toLowerCase() },
          isPending: false,
          isFetching: false,
        });
        show(viewAs({ canApprove: false, email: "kim@team.dev" }, []));

        expect(
          await within(card()).findByRole("button", {
            name: "Request this iPhone",
          }),
        ).toBeTruthy();
        expect(
          within(card()).queryByRole("link", { name: "Install profile" }),
        ).toBeNull();
        // Kept again, so the build page knows this iPhone too.
        expect(
          window.localStorage.getItem("hot-updater-ios-udid")?.toLowerCase(),
        ).toBe(PHONE.toLowerCase());
      }),
    );

    it(
      "offers the profile when the cookie proves another iPhone, or another person's",
      onHttps(async () => {
        onIphone();
        window.localStorage.setItem("hot-updater-ios-udid", PHONE);
        registryHas(null);
        // The server answers null for another person's cookie.
        keptQuery.mockReturnValue({
          data: { udid: "00008110-001a2b3c4d5e6f70" },
          isPending: false,
          isFetching: false,
        });
        show(viewAs({}, []));

        expect(
          await within(card()).findByRole("link", { name: "Install profile" }),
        ).toBeTruthy();
        expect(
          within(card()).queryByRole("button", { name: "Request this iPhone" }),
        ).toBeNull();
      }),
    );

    it(
      "trades the register answer's receipt for the cookie on the way back",
      onHttps(async () => {
        onIphone();
        registryHas(mine());
        show(viewAs({}, [mine()]));

        await within(card()).findByText("Requested");
        expect(keptQuery).toHaveBeenCalledWith("", "receipt.sig", true);
      }, `#udid=${PHONE}&r=receipt.sig&requested=1`),
    );

    it("leaves a computer's QR code as it was, whatever it kept", () => {
      window.localStorage.setItem("hot-updater-ios-udid", PHONE);
      registryHas(mine());
      show(viewAs({}, [mine()]));

      expect(
        within(card()).getByRole("img", {
          name: "Open this page on an iPhone",
        }),
      ).toBeTruthy();
      expect(within(card()).queryByText("Requested")).toBeNull();
    });
  });

  it("lets the page scroll past a tall list on a phone: the list's frame never shrinks to the leftover height", () => {
    mobile.value = true;
    try {
      show(viewAs({}, [device()]));
      const frame = screen
        .getByRole("list", { name: "iOS devices" })
        .closest(".rounded-lg") as HTMLElement;
      expect(frame.className).toContain("flex-none");
      expect(frame.className).not.toContain("flex-1");
    } finally {
      mobile.value = false;
    }
  });
});

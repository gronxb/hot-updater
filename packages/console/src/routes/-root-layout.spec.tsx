import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConsoleAccessRpc,
  getConsoleAuthProvidersRpc,
} from "@/lib/auth-rpc";
import { consoleFeaturesQueryKey } from "@/lib/console-features-api";
import { getConsoleFeaturesRpc } from "@/lib/console-features-rpc";
import { getSchemaMigrationRpc } from "@/lib/schema-migration-rpc";

vi.mock("react-grab", () => ({}));

vi.mock("@tanstack/react-router", () => ({
  createRootRouteWithContext: () => (options: unknown) => ({
    options,
    useLoaderData: () => ({
      access: {
        status: "authorized",
        principal: { email: "local@hot-updater.dev" },
      },
      providers: [],
    }),
  }),
  HeadContent: () => null,
  Outlet: () => <div>Current route</div>,
  Scripts: () => null,
}));

vi.mock("@/components/AppSidebar", () => ({
  AppSidebar: () => null,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({
    children,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
  }) => <main className={className}>{children}</main>,
  SidebarProvider: ({ children }: { readonly children: React.ReactNode }) =>
    children,
  SidebarTrigger: () => null,
}));
vi.mock("@/lib/auth-rpc", () => ({
  getConsoleAccessRpc: vi.fn(),
  getConsoleAuthProvidersRpc: vi.fn(),
}));
vi.mock("@/lib/console-features-rpc", () => ({
  getConsoleFeaturesRpc: vi.fn(),
}));
vi.mock("@/lib/schema-migration-rpc", () => ({
  getSchemaMigrationRpc: vi.fn(),
}));

import { Route } from "./__root";

const RootLayout = Route.options.component;
if (!RootLayout) throw new Error("Root layout component is required");

type RootLoader = (match: {
  readonly context: { readonly queryClient: QueryClient };
}) => Promise<unknown>;
const loader = Route.options.loader as unknown as RootLoader;

/** The root layout with the query client the router provides. */
const renderLayout = (queryClient = new QueryClient()) =>
  render(
    <QueryClientProvider client={queryClient}>
      <RootLayout />
    </QueryClientProvider>,
  );

/** What the schema fence found, as the console's status read returns it. */
const status = {
  message: "The database needs migrations.",
  settings: [{ key: "schema.remoteConfig", expected: "1", found: null }],
  plugins: ["remoteConfig"],
  migratable: true,
};

describe("RootLayout", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(getSchemaMigrationRpc).mockReset();
  });

  it("contains route overflow inside the sidebar inset", () => {
    // Given / When
    renderLayout();

    // Then
    expect(screen.getByRole("main").className).toContain("overflow-hidden");
  });

  it("reads nothing more while the pages' reads pass", async () => {
    // Given
    const queryClient = new QueryClient();
    await queryClient.fetchQuery({
      queryKey: ["channels"],
      queryFn: async () => [],
    });

    // When
    renderLayout(queryClient);

    // Then
    expect(screen.getByText("Current route")).toBeInstanceOf(HTMLElement);
    expect(getSchemaMigrationRpc).not.toHaveBeenCalled();
  });

  it("shows the migration notice instead of the page when a read failed on the fence, and checks again", async () => {
    // Given a page's read the schema fence refused
    vi.mocked(getSchemaMigrationRpc).mockResolvedValue(status);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let migrated = false;
    await queryClient
      .fetchQuery({
        queryKey: ["channels"],
        queryFn: async () => {
          if (!migrated) throw new Error(status.message);
          return [];
        },
      })
      .catch(() => undefined);

    // When
    renderLayout(queryClient);

    // Then
    expect(
      await screen.findByText("The database needs a migration"),
    ).toBeInstanceOf(HTMLElement);
    expect(screen.queryByText("Current route")).toBeNull();
    expect(screen.getByText("npx hot-updater doctor")).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getByText("schema.remoteConfig")).toBeInstanceOf(HTMLElement);

    // When the database is migrated and the user checks again
    migrated = true;
    vi.mocked(getSchemaMigrationRpc).mockResolvedValue(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    });

    // Then the page mounts and reads again
    expect(await screen.findByText("Current route")).toBeInstanceOf(
      HTMLElement,
    );
  });

  it("sends a database a newer release migrated to doctor", async () => {
    // Given
    vi.mocked(getSchemaMigrationRpc).mockResolvedValue({
      ...status,
      settings: [{ key: "schema.core", expected: "1.0.0", found: "1.2.0" }],
      plugins: [],
      migratable: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await queryClient
      .fetchQuery({
        queryKey: ["channels"],
        queryFn: async () => {
          throw new Error(status.message);
        },
      })
      .catch(() => undefined);

    // When
    renderLayout(queryClient);

    // Then
    expect(
      await screen.findByText("The database's schema doesn't match"),
    ).toBeInstanceOf(HTMLElement);
    expect(screen.getByText("npx hot-updater doctor")).toBeInstanceOf(
      HTMLElement,
    );
  });

  it("leaves a failure the fence did not cause to the page", async () => {
    // Given
    vi.mocked(getSchemaMigrationRpc).mockResolvedValue(null);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await queryClient
      .fetchQuery({
        queryKey: ["channels"],
        queryFn: async () => {
          throw new Error("Offline");
        },
      })
      .catch(() => undefined);

    // When
    renderLayout(queryClient);

    // Then
    await act(async () => {});
    expect(getSchemaMigrationRpc).toHaveBeenCalled();
    expect(screen.getByText("Current route")).toBeInstanceOf(HTMLElement);
  });
});

describe("root loader", () => {
  const served = {
    features: {
      insights: true,
      insightsAnalytics: false,
      apiKeys: false,
      remoteConfig: false,
    },
    remote: true,
  };

  afterEach(() => vi.resetAllMocks());

  it("loads the features with the authorized layout, whose navigation shows them", async () => {
    vi.mocked(getConsoleAccessRpc).mockResolvedValue({
      status: "authorized",
      principal: { email: "admin@example.com" },
    });
    vi.mocked(getConsoleAuthProvidersRpc).mockResolvedValue(["github"]);
    vi.mocked(getConsoleFeaturesRpc).mockResolvedValue(served);
    const queryClient = new QueryClient();

    await expect(loader({ context: { queryClient } })).resolves.toMatchObject({
      access: { status: "authorized" },
      providers: ["github"],
    });
    expect(queryClient.getQueryData(consoleFeaturesQueryKey)).toEqual(served);
  });

  it("asks for no features before the visitor is authorized", async () => {
    vi.mocked(getConsoleAccessRpc).mockResolvedValue({
      status: "unauthenticated",
    });
    vi.mocked(getConsoleAuthProvidersRpc).mockResolvedValue(["github"]);

    await loader({ context: { queryClient: new QueryClient() } });

    expect(getConsoleFeaturesRpc).not.toHaveBeenCalled();
  });

  it("still loads the console when the features cannot be read", async () => {
    vi.mocked(getConsoleAccessRpc).mockResolvedValue({
      status: "authorized",
      principal: { email: "admin@example.com" },
    });
    vi.mocked(getConsoleAuthProvidersRpc).mockResolvedValue([]);
    vi.mocked(getConsoleFeaturesRpc).mockRejectedValue(new Error("Offline"));

    await expect(
      loader({
        context: {
          queryClient: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
      }),
    ).resolves.toMatchObject({ access: { status: "authorized" } });
  });
});

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  remoteConfig,
  type RemoteConfigApi,
} from "@hot-updater/server/plugins/remote-config";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalRemoteConfig } from "@/lib/server/remoteConfig";

import { RemoteConfigPage } from "./RemoteConfigPage";

const state = vi.hoisted(() => ({
  api: null as RemoteConfigApi | null,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

/** The server functions, answered by a real `remoteConfig()` on a memory database. */
vi.mock("@/lib/remote-config-rpc", async () => {
  const console = () => createLocalRemoteConfig(state.api!);
  return {
    getRemoteConfigRpc: () => console().getActive(),
    listRemoteConfigVersionsRpc: ({ data }: { data: { cursor?: string } }) =>
      console().listVersions({ limit: 20, ...data }),
    getRemoteConfigVersionRpc: ({ data }: { data: { version: number } }) =>
      console().getVersion(data.version),
    publishRemoteConfigRpc: ({ data }: { data: never }) =>
      console().publish(data),
    rollbackRemoteConfigRpc: ({ data }: { data: never }) =>
      console().rollback(data),
    previewRemoteConfigRpc: async () => ({ status: "ok", parameters: {} }),
  };
});

vi.mock("sonner", () => ({
  toast: { error: state.toastError, success: state.toastSuccess },
}));

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({ data: [{ id: "1", name: "beta" }] }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">Toggle sidebar</button>,
}));

vi.mock("@/components/ui/dialog", async () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Wrapper,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

const renderPage = (tab: "parameters" | "conditions" = "parameters") => {
  const onTabChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RemoteConfigPage onTabChange={onTabChange} tab={tab} />
    </QueryClientProvider>,
  );
  return { onTabChange };
};

const lastDialog = () => {
  const dialogs = screen.getAllByRole("dialog");
  return within(dialogs[dialogs.length - 1]!);
};

beforeEach(() => {
  state.api = createHotUpdater({
    database: { name: "memory", adapter: createMemoryAdapter() },
    plugins: [remoteConfig()],
    clientAccess: "public",
  }).api.remoteConfig;
  state.toastSuccess.mockReset();
  state.toastError.mockReset();
});

afterEach(cleanup);

describe("RemoteConfigPage", () => {
  it("adds a first parameter from the empty state and publishes it as version 1", async () => {
    renderPage();
    expect(await screen.findByText("No parameters")).toBeDefined();
    expect(screen.getByText("Nothing published yet")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Add parameter" })[1]!);
    const dialog = lastDialog();
    fireEvent.change(dialog.getByLabelText("Key"), {
      target: { value: "welcome_message" },
    });
    fireEvent.change(dialog.getByLabelText("Default value"), {
      target: { value: "Hello" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add parameter" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    const list = within(screen.getByRole("list", { name: "Parameters" }));
    expect(list.getByText("welcome_message")).toBeDefined();
    expect(list.getByText("Hello")).toBeDefined();
    expect(screen.getByText("Unpublished changes")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    const publish = lastDialog();
    expect(publish.getByText("welcome_message")).toBeDefined();
    fireEvent.change(publish.getByLabelText("Description"), {
      target: { value: "Launch copy" },
    });
    fireEvent.click(publish.getByRole("button", { name: "Publish version 1" }));

    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith("Published version 1"),
    );
    expect(await screen.findByText(/^Version 1/u)).toBeDefined();
    expect(screen.queryByText("Unpublished changes")).toBeNull();
    await expect(state.api!.getActive()).resolves.toMatchObject({
      version: 1,
      template: {
        parameters: {
          welcome_message: {
            valueType: "STRING",
            defaultValue: { value: "Hello" },
          },
        },
      },
    });
  });

  it("checks a parameter before it joins the draft", async () => {
    renderPage();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Add parameter" }))[0]!,
    );
    const dialog = lastDialog();
    fireEvent.change(dialog.getByLabelText("Key"), {
      target: { value: "2fast" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add parameter" }));

    expect(
      dialog.getByText(
        "Start with a letter or _, then use letters, digits, and _.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("adds a condition from the parameter dialog and gives it a value there", async () => {
    renderPage();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Add parameter" }))[0]!,
    );
    fireEvent.change(lastDialog().getByLabelText("Key"), {
      target: { value: "banner" },
    });
    fireEvent.click(lastDialog().getByRole("button", { name: "New condition" }));

    const condition = lastDialog();
    fireEvent.change(condition.getByLabelText("Name"), {
      target: { value: "iOS users" },
    });
    fireEvent.click(condition.getByRole("button", { name: "Add condition" }));

    // Back in the parameter dialog, with a value for the new condition.
    const parameter = lastDialog();
    fireEvent.change(parameter.getByLabelText("Value for iOS users"), {
      target: { value: "Hello, iOS" },
    });
    fireEvent.click(parameter.getByRole("button", { name: "Add parameter" }));

    const list = within(screen.getByRole("list", { name: "Parameters" }));
    expect(list.getByText("iOS users")).toBeDefined();
    expect(list.getByText("Hello, iOS")).toBeDefined();
    expect(
      screen.getByRole("tab", { name: /Conditions\s*1/u }),
    ).toBeDefined();
  });

  it("offers to load or publish over a version someone else published meanwhile", async () => {
    await state.api!.publish({
      template: {
        parameters: {
          theme: { valueType: "STRING", defaultValue: { value: "light" } },
        },
      },
      baseVersion: 0,
    });
    renderPage();
    const list = within(await screen.findByRole("list", { name: "Parameters" }));
    fireEvent.click(list.getByRole("button", { name: "Delete theme" }));

    // Another editor publishes version 2 before this one does.
    await state.api!.publish({ template: {}, baseVersion: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    fireEvent.click(
      lastDialog().getByRole("button", { name: "Publish version 2" }),
    );
    expect(
      await screen.findByText("Version 2 was published while you edited"),
    ).toBeDefined();

    fireEvent.click(
      lastDialog().getByRole("button", { name: "Publish mine after it" }),
    );
    fireEvent.click(
      lastDialog().getByRole("button", { name: "Publish version 3" }),
    );
    await waitFor(() =>
      expect(state.toastSuccess).toHaveBeenCalledWith("Published version 3"),
    );
  });

  it("discards unpublished changes", async () => {
    await state.api!.publish({
      template: {
        parameters: {
          theme: { valueType: "STRING", defaultValue: { value: "light" } },
        },
      },
      baseVersion: 0,
    });
    renderPage();
    const list = within(await screen.findByRole("list", { name: "Parameters" }));
    fireEvent.click(list.getByRole("button", { name: "Delete theme" }));
    expect(screen.getByText("No parameters")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("theme")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Publish changes" })).toBeNull();
  });

  it("keeps the open view in the route", async () => {
    const { onTabChange } = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: /Versions/u }));
    expect(onTabChange).toHaveBeenCalledWith("versions");
  });
});

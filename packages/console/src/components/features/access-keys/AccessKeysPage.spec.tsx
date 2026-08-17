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

import { AccessKeysPage } from "./AccessKeysPage";

const {
  createMutation,
  revokeMutation,
  accessKeysQuery,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  createMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  },
  revokeMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  accessKeysQuery: {
    data: [] as Array<Record<string, unknown>>,
    error: null as Error | null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock("@/lib/access-keys-api", () => ({
  useCreateClientAccessKeyMutation: () => createMutation,
  useClientAccessKeysQuery: () => accessKeysQuery,
  useRevokeClientAccessKeyMutation: () => revokeMutation,
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const Context = React.createContext<{
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }>({ open: false });
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange?: (open: boolean) => void;
      open: boolean;
    }) =>
      open ? (
        <Context.Provider value={{ onOpenChange, open }}>
          <div role="dialog">{children}</div>
        </Context.Provider>
      ) : null,
    DialogContent: Wrapper,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

vi.mock("@/components/ui/alert-dialog", async () => {
  const React = await import("react");
  const Context = React.createContext<{
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }>({ open: false });
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange?: (open: boolean) => void;
      open: boolean;
    }) => (
      <Context.Provider value={{ onOpenChange, open }}>
        {children}
      </Context.Provider>
    ),
    AlertDialogAction: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    }) => (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({
      children,
      disabled,
    }: {
      children: ReactNode;
      disabled?: boolean;
    }) => <button disabled={disabled}>{children}</button>,
    AlertDialogContent: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(Context);
      return open ? <div role="alertdialog">{children}</div> : null;
    },
    AlertDialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogFooter: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogMedia: Wrapper,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => (
      <h2>{children}</h2>
    ),
    AlertDialogTrigger: ({
      children,
      render,
    }: {
      children: ReactNode;
      render?: ReactNode;
    }) => {
      const { onOpenChange } = React.useContext(Context);
      if (!React.isValidElement(render)) return null;
      return React.cloneElement(
        render as React.ReactElement<{
          children?: ReactNode;
          onClick?: () => void;
        }>,
        { children, onClick: () => onOpenChange?.(true) },
      );
    },
  };
});

describe("AccessKeysPage", () => {
  beforeEach(() => {
    accessKeysQuery.data = [];
    accessKeysQuery.error = null;
    accessKeysQuery.isError = false;
    accessKeysQuery.isLoading = false;
    accessKeysQuery.refetch.mockReset();
    createMutation.isPending = false;
    createMutation.mutateAsync.mockReset();
    createMutation.reset.mockReset();
    revokeMutation.isPending = false;
    revokeMutation.mutateAsync.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  afterEach(cleanup);

  it("shows a newly created plaintext key once and clears it on close", async () => {
    const apiKey = "a".repeat(43);
    createMutation.mutateAsync.mockResolvedValue({ apiKey });
    render(<AccessKeysPage />);

    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Production app " },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Create key" })[1]!);

    expect(await screen.findByDisplayValue(apiKey)).toBeDefined();
    expect(createMutation.mutateAsync).toHaveBeenCalledWith("Production app");
    expect(screen.getByText(/shown once/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(screen.queryByDisplayValue(apiKey)).toBeNull();
    expect(screen.getByLabelText("Name")).toBeDefined();
  });

  it("keeps revoke confirmation open until persistence succeeds", async () => {
    let resolveRevoke: (() => void) | undefined;
    revokeMutation.mutateAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRevoke = resolve;
        }),
    );
    accessKeysQuery.data = [
      {
        created_at_ms: 1_700_000_000_000,
        id: `client-${"b".repeat(43)}`,
        name: "Production app",
        prefix: "abcdef",
        revoked_at_ms: null,
        role: "client",
      },
    ];
    render(<AccessKeysPage />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));

    expect(revokeMutation.mutateAsync).toHaveBeenCalledWith(
      `client-${"b".repeat(43)}`,
    );
    expect(screen.getByRole("alertdialog")).toBeDefined();

    resolveRevoke?.();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(toastSuccess).toHaveBeenCalledWith("Access key revoked");
  });

  it("presents a key as one compact identity without repeated permissions", () => {
    accessKeysQuery.data = [
      {
        created_at_ms: 1_700_000_000_000,
        id: `client-${"b".repeat(43)}`,
        name: "Production app",
        prefix: "abcdef",
        revoked_at_ms: null,
        role: "client",
      },
    ];

    render(<AccessKeysPage />);
    const row = screen.getByRole("row", { name: /Production app/ });

    expect(within(row).getByText("Production app")).toBeDefined();
    expect(within(row).getByText("abcdef…")).toBeDefined();
    expect(screen.queryByText("OTA read")).toBeNull();
    expect(screen.queryByText("Analytics write")).toBeNull();
  });

  it("offers a useful empty state and a retryable error state", () => {
    const { rerender } = render(<AccessKeysPage />);

    expect(screen.getByText("No client keys")).toBeDefined();
    expect(screen.getByText("Create a key to connect an app.")).toBeDefined();

    accessKeysQuery.error = new Error("database relation is missing");
    accessKeysQuery.isError = true;
    rerender(<AccessKeysPage />);

    expect(screen.getByText("Access keys couldn't be loaded")).toBeDefined();
    expect(screen.queryByText("database relation is missing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(accessKeysQuery.refetch).toHaveBeenCalledOnce();
  });
});

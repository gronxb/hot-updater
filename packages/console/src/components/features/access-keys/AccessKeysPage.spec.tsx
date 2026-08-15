import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    AlertDialogTrigger: ({ children }: { children: ReactNode }) => {
      const { onOpenChange } = React.useContext(Context);
      if (!React.isValidElement(children)) return null;
      return React.cloneElement(
        children as React.ReactElement<{
          onClick?: () => void;
        }>,
        { onClick: () => onOpenChange?.(true) },
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
});

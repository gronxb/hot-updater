import { useState } from "react";

import { HotUpdaterLogo } from "@/components/HotUpdaterLogo";
import { Button } from "@/components/ui/button";

import type { ConsoleAccess, ConsoleAuthProvider } from "../index";

type ConsoleAccessPageProps = {
  readonly access: Exclude<ConsoleAccess, { status: "authorized" }>;
  readonly providers: readonly ConsoleAuthProvider[];
};

const providerLabel: Record<ConsoleAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

export function ConsoleAccessPage({
  access,
  providers,
}: ConsoleAccessPageProps) {
  const [pendingProvider, setPendingProvider] =
    useState<ConsoleAuthProvider | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (provider: ConsoleAuthProvider) => {
    setPendingProvider(provider);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        body: JSON.stringify({ callbackURL: "/", provider }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json()) as { readonly url?: unknown };
      if (!response.ok || typeof result.url !== "string") {
        throw new Error("The identity provider did not return a sign-in URL.");
      }
      window.location.assign(result.url);
    } catch (cause) {
      setPendingProvider(null);
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) {
        throw new Error("Sign-out failed.");
      }
      window.location.reload();
    } catch (cause) {
      setSigningOut(false);
      setError(cause instanceof Error ? cause.message : "Sign-out failed.");
    }
  };

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <section className="border-border bg-card w-full max-w-sm rounded-xl border p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <HotUpdaterLogo className="h-10 w-7" />
          <div>
            <h1 className="text-lg font-semibold">Hot Updater Console</h1>
            <p className="text-muted-foreground text-sm">
              Sign in to manage OTA releases.
            </p>
          </div>
        </div>

        {access.status === "forbidden" ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Access denied</p>
            <p className="text-muted-foreground text-sm">
              {access.principal.email} is not in the console allowlist.
            </p>
            <Button
              className="w-full"
              disabled={signingOut}
              onClick={() => void signOut()}
              size="lg"
              variant="outline"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        ) : providers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No OAuth provider is configured for this console.
          </p>
        ) : (
          <div className="grid gap-2">
            {providers.map((provider) => (
              <Button
                className="w-full"
                disabled={pendingProvider !== null}
                key={provider}
                onClick={() => void signIn(provider)}
                size="lg"
                variant="outline"
              >
                {pendingProvider === provider
                  ? "Redirecting…"
                  : `Continue with ${providerLabel[provider]}`}
              </Button>
            ))}
          </div>
        )}

        {error ? (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

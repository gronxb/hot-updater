import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { getConsoleSessionState } from "@/lib/auth-rpc";

const consoleHomeSearch = {
  after: undefined,
  before: undefined,
  bundleId: undefined,
  channel: undefined,
  expandedBundleId: undefined,
  page: undefined,
  platform: undefined,
};

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const { authenticated } = await getConsoleSessionState();
    if (authenticated) {
      throw redirect({ search: consoleHomeSearch, to: "/" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const { error } = await authClient.signIn.email({
        email,
        password,
      });

      if (error) {
        setErrorMessage(error.message ?? "Sign in failed.");
        return;
      }

      await navigate({ search: consoleHomeSearch, to: "/" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/5 px-4 py-8">
      <Card className="w-full max-w-sm rounded-lg shadow-sm">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md border bg-background">
              <LogIn className="size-4 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">Hot Updater Console</CardTitle>
          </div>
          <CardDescription>
            Sign in with the admin account created by the bootstrap command.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {errorMessage ? (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                autoComplete="email"
                inputMode="email"
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                autoComplete="current-password"
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button className="h-8 w-full" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

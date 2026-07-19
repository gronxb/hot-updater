import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getProtectedAnalyticsRouteDecision } from "@/lib/analytics-api";

import { useAnalyticsCapability } from "./AnalyticsCapabilityContext";

const isProtectedPath = (pathname: string): boolean =>
  pathname === "/analytics" || pathname === "/installations";

export function AnalyticsRouteGate({
  children,
  onRedirect,
  pathname,
}: {
  readonly children: ReactNode;
  readonly onRedirect: () => void;
  readonly pathname: string;
}) {
  const capability = useAnalyticsCapability();
  const decision = isProtectedPath(pathname)
    ? getProtectedAnalyticsRouteDecision(capability)
    : "allow";
  const shouldRedirect = decision === "redirect";

  useEffect(() => {
    if (shouldRedirect) {
      onRedirect();
    }
  }, [onRedirect, shouldRedirect]);

  if (decision === "allow") {
    return children;
  }

  if (decision === "loading") {
    return (
      <div
        aria-label="Loading analytics capability"
        className="flex h-svh flex-col gap-4 p-3 sm:p-6"
        role="status"
      >
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (decision === "error" && capability.status === "error") {
    return (
      <div className="flex h-svh items-start justify-center p-3 pt-20 sm:p-6 sm:pt-24">
        <Alert className="max-w-lg" variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Analytics capability unavailable</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{capability.error.message}</span>
            <Button asChild size="sm" variant="outline">
              <Link
                to="/"
                search={{
                  channel: undefined,
                  platform: undefined,
                  page: undefined,
                  after: undefined,
                  before: undefined,
                  bundleId: undefined,
                  expandedBundleId: undefined,
                }}
              >
                Back to Bundles
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return null;
}

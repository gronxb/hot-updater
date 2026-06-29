import type { TelemetryKeyResult } from "@hot-updater/plugin-core";
import { Copy, KeyRound, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useConfigQuery,
  useIssueTelemetryKeyMutation,
  useRotateTelemetryKeyMutation,
  useTelemetryKeyQuery,
} from "@/lib/api";

export function SettingsPage() {
  const [freshKey, setFreshKey] = useState<TelemetryKeyResult | null>(null);
  const configQuery = useConfigQuery();
  const providerSupportsTelemetryKey =
    configQuery.data?.capabilities?.telemetryKey === true;
  const telemetryKeyQuery = useTelemetryKeyQuery(providerSupportsTelemetryKey);
  const issueTelemetryKeyMutation = useIssueTelemetryKeyMutation();
  const rotateTelemetryKeyMutation = useRotateTelemetryKeyMutation();
  const isSupported =
    providerSupportsTelemetryKey && telemetryKeyQuery.isSupported;
  const storedSuffix = telemetryKeyQuery.data?.telemetryKeySuffix ?? null;
  const displayValue = freshKey
    ? freshKey.telemetryKey
    : storedSuffix
      ? `...${storedSuffix}`
      : null;
  const hasKey = Boolean(displayValue);
  const isMutating =
    issueTelemetryKeyMutation.isPending || rotateTelemetryKeyMutation.isPending;
  const isBusy = isMutating || telemetryKeyQuery.isLoading;

  useEffect(() => {
    if (freshKey && !telemetryKeyQuery.isFetching && storedSuffix) {
      setFreshKey(null);
    }
  }, [freshKey, storedSuffix, telemetryKeyQuery.isFetching]);

  const issueKey = async () => {
    try {
      setFreshKey(await issueTelemetryKeyMutation.mutateAsync());
    } catch (error) {
      toast.error("Failed to issue Telemetry key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const rotateKey = async () => {
    try {
      setFreshKey(await rotateTelemetryKeyMutation.mutateAsync());
    } catch (error) {
      toast.error("Failed to rotate Telemetry key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const copyFreshKey = async () => {
    if (!freshKey) return;

    try {
      await navigator.clipboard.writeText(freshKey.telemetryKey);
      toast.success("Telemetry key copied");
    } catch (error) {
      toast.error("Failed to copy Telemetry key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <main className="flex h-svh min-h-0 flex-col bg-muted/5">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/70 px-3 py-3 sm:px-6">
        <h1 className="text-sm font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-6">
        <Card className="max-w-2xl rounded-lg shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="size-4" />
              Telemetry key
            </CardTitle>
            <CardDescription>
              Runtime credential for lifecycle telemetry.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {configQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : configQuery.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Telemetry key failed to load</AlertTitle>
                <AlertDescription>
                  {configQuery.error instanceof Error
                    ? configQuery.error.message
                    : "Try again."}
                </AlertDescription>
              </Alert>
            ) : !isSupported ? (
              <Alert>
                <AlertTitle>Telemetry key not available</AlertTitle>
                <AlertDescription>
                  This provider does not support Telemetry key management.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <code className="min-w-0 break-all font-mono text-xs">
                    {telemetryKeyQuery.isLoading
                      ? "Loading Telemetry key..."
                      : (displayValue ?? "No Telemetry key issued")}
                  </code>
                  {freshKey ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyFreshKey()}
                    >
                      <Copy data-icon="inline-start" />
                      Copy
                    </Button>
                  ) : null}
                </div>
                {telemetryKeyQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Telemetry key failed to load</AlertTitle>
                    <AlertDescription>
                      {telemetryKeyQuery.error instanceof Error
                        ? telemetryKeyQuery.error.message
                        : "Try again."}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={isBusy}
                    onClick={() => void (hasKey ? rotateKey() : issueKey())}
                  >
                    <RotateCw data-icon="inline-start" />
                    {telemetryKeyQuery.isLoading
                      ? "Loading..."
                      : isMutating
                        ? hasKey
                          ? "Rotating..."
                          : "Issuing..."
                        : hasKey
                          ? "Rotate Telemetry key"
                          : "Issue Telemetry key"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

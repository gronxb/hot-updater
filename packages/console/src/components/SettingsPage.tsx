import type { TelemetryKeyResult } from "@hot-updater/plugin-core";
import { Copy, KeyRound, Power, PowerOff, RotateCw } from "lucide-react";
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
  useSetTelemetryKeyActiveMutation,
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
  const setTelemetryKeyActiveMutation = useSetTelemetryKeyActiveMutation();
  const isSupported =
    providerSupportsTelemetryKey && telemetryKeyQuery.isSupported;
  const storedSuffix = telemetryKeyQuery.data?.telemetryKeySuffix ?? null;
  const isActive = telemetryKeyQuery.data?.active ?? false;
  const displayValue = freshKey
    ? freshKey.telemetryKey
    : storedSuffix
      ? `...${storedSuffix}`
      : null;
  const hasKey = Boolean(displayValue);
  const isMutating =
    issueTelemetryKeyMutation.isPending ||
    rotateTelemetryKeyMutation.isPending ||
    setTelemetryKeyActiveMutation.isPending;
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
      toast.error("Failed to issue Ingest key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const rotateKey = async () => {
    try {
      setFreshKey(await rotateTelemetryKeyMutation.mutateAsync());
    } catch (error) {
      toast.error("Failed to rotate Ingest key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const copyFreshKey = async () => {
    if (!freshKey) return;

    try {
      await navigator.clipboard.writeText(freshKey.telemetryKey);
      toast.success("Ingest key copied");
    } catch (error) {
      toast.error("Failed to copy Ingest key", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const setKeyActive = async (active: boolean) => {
    try {
      await setTelemetryKeyActiveMutation.mutateAsync({ active });
    } catch (error) {
      toast.error(
        active ? "Failed to enable Ingest key" : "Failed to disable Ingest key",
        {
          description: error instanceof Error ? error.message : undefined,
        },
      );
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
              Ingest key
            </CardTitle>
            <CardDescription>
              Runtime credential for lifecycle event ingestion.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {configQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : configQuery.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Ingest key failed to load</AlertTitle>
                <AlertDescription>
                  {configQuery.error instanceof Error
                    ? configQuery.error.message
                    : "Try again."}
                </AlertDescription>
              </Alert>
            ) : !isSupported ? (
              <Alert>
                <AlertTitle>Ingest key not available</AlertTitle>
                <AlertDescription>
                  This provider does not support Ingest key management.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="grid min-w-0 gap-1">
                    <code className="min-w-0 break-all font-mono text-xs">
                      {telemetryKeyQuery.isLoading
                        ? "Loading Ingest key..."
                        : (displayValue ?? "No Ingest key issued")}
                    </code>
                    {storedSuffix ? (
                      <span className="text-xs text-muted-foreground">
                        {isActive ? "Enabled" : "Disabled"}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {storedSuffix ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => void setKeyActive(!isActive)}
                      >
                        {isActive ? (
                          <PowerOff data-icon="inline-start" />
                        ) : (
                          <Power data-icon="inline-start" />
                        )}
                        {isActive ? "Disable" : "Enable"}
                      </Button>
                    ) : null}
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
                </div>
                {telemetryKeyQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Ingest key failed to load</AlertTitle>
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
                          ? "Rotate Ingest key"
                          : "Issue Ingest key"}
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

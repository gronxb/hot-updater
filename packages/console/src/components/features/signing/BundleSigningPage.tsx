import { AlertTriangle, CheckCircle2, Info, RefreshCw } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBundleSigningInspectionQuery } from "@/lib/bundle-signing-api";
import type { BundleSigningInspection } from "@/lib/bundle-signing-rpc";

function InspectionLoading() {
  return (
    <div aria-label="Loading bundle signing" className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-4/5" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-3/5" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-56 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function InspectionError({ refetch }: { readonly refetch: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Bundle signing couldn't be loaded</AlertTitle>
      <AlertDescription>
        Check the Console connection and try again.
      </AlertDescription>
      <AlertAction>
        <Button onClick={refetch} size="xs" variant="outline">
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function SigningStatusCard({
  inspection,
}: {
  readonly inspection: BundleSigningInspection;
}) {
  const enabled = inspection.status === "enabled";
  const status = enabled ? "Enabled" : "Disabled";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            <h2>Signing status</h2>
          </CardTitle>
          <Badge variant={enabled ? "default" : "outline"}>{status}</Badge>
        </div>
        <CardDescription>
          {enabled
            ? "Bundle signing is enabled in the current Hot Updater configuration."
            : "Bundle signing is disabled in the current Hot Updater configuration."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {inspection.status === "disabled" ? (
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>Configure signing outside the Console</AlertTitle>
            <AlertDescription>
              Use your signing provider or the Hot Updater CLI to configure a
              key. The Console never creates or stores private keys.
            </AlertDescription>
          </Alert>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-muted-foreground">Provider</dt>
              <dd className="truncate text-sm font-medium">
                {inspection.provider}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-muted-foreground">Algorithm</dt>
              <dd className="text-sm font-medium">{inspection.algorithm}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function BundleSigningPage() {
  const inspection = useBundleSigningInspectionQuery();

  if (inspection.isLoading) return <InspectionLoading />;
  if (inspection.isError || !inspection.data) {
    return <InspectionError refetch={() => void inspection.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <SigningStatusCard inspection={inspection.data} />
      <Alert>
        <CheckCircle2 aria-hidden="true" />
        <AlertTitle>Read-only inspection</AlertTitle>
        <AlertDescription>
          Configure or rotate signing keys through the provider or Hot Updater
          CLI. The Console never accesses signing credentials.
        </AlertDescription>
      </Alert>
    </div>
  );
}

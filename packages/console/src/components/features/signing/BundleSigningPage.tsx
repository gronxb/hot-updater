import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  Info,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import { useBundleSigningInspectionQuery } from "@/lib/bundle-signing-api";
import type { BundleSigningInspection } from "@/lib/bundle-signing-rpc";

const PUBLIC_KEY_FILENAME = "hot-updater-public-key.pem";

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
  const misconfigured = inspection.status === "misconfigured";
  const status = enabled
    ? "Enabled"
    : misconfigured
      ? "Misconfigured"
      : "Disabled";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            <h2>Signing status</h2>
          </CardTitle>
          <Badge
            variant={
              misconfigured ? "destructive" : enabled ? "default" : "outline"
            }
          >
            {status}
          </Badge>
        </div>
        <CardDescription>
          {enabled
            ? "The Console found the public key configured for bundle verification."
            : misconfigured
              ? "Signing is enabled, but the public key cannot be inspected safely."
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
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs text-muted-foreground">Provider</dt>
                <dd className="truncate text-sm font-medium">
                  {inspection.provider}
                </dd>
              </div>
              {inspection.status === "enabled" ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">Algorithm</dt>
                  <dd className="text-sm font-medium">
                    {inspection.algorithm}
                  </dd>
                </div>
              ) : null}
            </dl>
            {inspection.status === "enabled" ? (
              <div className="flex min-w-0 flex-col gap-1 border-t pt-4">
                <p className="text-xs text-muted-foreground">
                  SPKI SHA-256 fingerprint
                </p>
                <p className="break-all font-mono text-xs">
                  {inspection.fingerprint}
                </p>
              </div>
            ) : (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Public key unavailable</AlertTitle>
                <AlertDescription>{inspection.message}</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PublicKeyCard({ publicKey }: { readonly publicKey: string }) {
  const copyPublicKey = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
      toast.success("Public key copied");
    } catch {
      toast.error("Unable to copy public key");
    }
  };

  const downloadPublicKey = () => {
    const url = URL.createObjectURL(
      new Blob([`${publicKey}\n`], { type: "application/x-pem-file" }),
    );
    const link = document.createElement("a");
    link.download = PUBLIC_KEY_FILENAME;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          <h2>Public key</h2>
        </CardTitle>
        <CardDescription>
          This public key may be embedded in native app configuration. Private
          key material is never available in the Console.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          aria-label="Bundle signing public key"
          className="min-h-56 resize-none font-mono text-xs"
          readOnly
          spellCheck={false}
          value={publicKey}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void copyPublicKey()}
            size="sm"
            variant="outline"
          >
            <Clipboard data-icon="inline-start" />
            Copy
          </Button>
          <Button onClick={downloadPublicKey} size="sm" variant="outline">
            <Download data-icon="inline-start" />
            Download
          </Button>
        </div>
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
      {inspection.data.status === "enabled" ? (
        <PublicKeyCard publicKey={inspection.data.publicKey} />
      ) : null}
      <Alert>
        <CheckCircle2 aria-hidden="true" />
        <AlertTitle>Read-only inspection</AlertTitle>
        <AlertDescription>
          Configure or rotate signing keys through the provider or Hot Updater
          CLI. The Console only reads a checked-in public key file.
        </AlertDescription>
      </Alert>
    </div>
  );
}

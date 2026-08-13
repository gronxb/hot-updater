import type { Bundle } from "@hot-updater/plugin-core";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";

import { BundleAnalyticsSummary } from "./BundleAnalyticsSummary";
import { BundleBasicInfo } from "./BundleBasicInfo";
import { BundleMetadata } from "./BundleMetadata";
import { DeleteBundleDialog } from "./DeleteBundleDialog";

interface BundleEditorSheetProps {
  bundleId?: string;
  bundle: Bundle | null;
  loading?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BundleEditorSheet({
  bundleId,
  bundle,
  loading = false,
  open,
  onOpenChange,
}: BundleEditorSheetProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const refreshThemeChrome = () => {
      window.dispatchEvent(new Event("hot-updater:refresh-theme-chrome"));
    };

    refreshThemeChrome();
    const timeoutId = window.setTimeout(refreshThemeChrome, 180);

    return () => window.clearTimeout(timeoutId);
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => onOpenChange(nextOpen);

  const closeSheet = () => {
    onOpenChange(false);
  };

  const headerContent = bundle ? (
    <BundleBasicInfo bundle={bundle} />
  ) : loading ? (
    bundleId ? (
      <span translate="no" className="font-mono text-xs">
        Loading {bundleId}…
      </span>
    ) : (
      "Loading bundle details…"
    )
  ) : bundleId ? (
    <span translate="no" className="font-mono text-xs">
      Bundle not found: {bundleId}
    </span>
  ) : (
    "Bundle details unavailable"
  );

  const bodyContent = bundle ? (
    <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6 sm:pb-6">
      <BundleAnalyticsSummary bundle={bundle} />
      <BundleMetadata bundle={bundle} />
      <div className="rounded-lg border bg-muted/20 p-4 text-sm">
        <p className="font-medium">Immutable artifact</p>
        <p className="mt-1 text-muted-foreground">
          Delivery targeting, rollout, force, and enabled state are owned by
          Releases. This view only exposes storage actions.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Button
            onClick={() => {
              window.open(
                `/api/bundles/${encodeURIComponent(bundle.id)}/download`,
                "_blank",
                "noopener,noreferrer",
              );
              toast.success("Bundle download started");
            }}
            variant="outline"
          >
            <Download className="size-4" /> Download Bundle
          </Button>
          <Button
            onClick={() => setShowDeleteDialog(true)}
            variant="destructive"
          >
            Delete Bundle
          </Button>
        </div>
      </div>
      <DeleteBundleDialog
        bundle={bundle}
        onOpenChange={setShowDeleteDialog}
        onSuccess={closeSheet}
        open={showDeleteDialog}
      />
    </div>
  ) : loading ? (
    <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  ) : (
    <div className="px-4 pb-4 text-sm text-muted-foreground sm:px-6 sm:pb-6">
      The requested bundle could not be loaded.
    </div>
  );

  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="top-0 left-0 h-dvh max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-0"
          showCloseButton
        >
          <div className="flex h-full flex-col overflow-hidden">
            <DialogHeader className="shrink-0 border-b border-border/70 px-4 py-4 sm:px-6">
              <DialogTitle>
                {bundle ? "Bundle Detail" : "Bundle Details"}
              </DialogTitle>
              <DialogDescription asChild>
                <div>{headerContent}</div>
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto">{bodyContent}</div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className="w-[600px] overflow-y-auto sm:max-w-[600px]"
        showCloseButton
      >
        <SheetHeader>
          <SheetTitle>{bundle ? "Bundle Detail" : "Bundle Details"}</SheetTitle>
          <div className="text-muted-foreground text-xs/relaxed">
            {headerContent}
          </div>
        </SheetHeader>
        {bodyContent}
      </SheetContent>
    </Sheet>
  );
}

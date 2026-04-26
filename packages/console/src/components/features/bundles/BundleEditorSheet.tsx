import type { Bundle } from "@hot-updater/plugin-core";
import { useEffect, useState } from "react";

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
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";

import { BundleBasicInfo } from "./BundleBasicInfo";
import { BundleEditorForm } from "./BundleEditorForm";
import { BundleMetadata } from "./BundleMetadata";

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
  const [isSaving, setIsSaving] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open) {
      setIsSaving(false);
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSaving) {
      return;
    }

    if (!nextOpen) {
      setIsSaving(false);
    }

    onOpenChange(nextOpen);
  };

  const closeSheet = () => {
    setIsSaving(false);
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
      <BundleEditorForm
        key={bundle.id}
        bundle={bundle}
        onClose={closeSheet}
        onBusyChange={setIsSaving}
      />
      <BundleMetadata bundle={bundle} />
    </div>
  ) : loading ? (
    <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
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
          showCloseButton={!isSaving}
          onEscapeKeyDown={(event) => {
            if (isSaving) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (isSaving) {
              event.preventDefault();
            }
          }}
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
        showCloseButton={!isSaving}
        onEscapeKeyDown={(event) => {
          if (isSaving) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isSaving) {
            event.preventDefault();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle>{bundle ? "Bundle Detail" : "Bundle Details"}</SheetTitle>
          <SheetDescription>{headerContent}</SheetDescription>
        </SheetHeader>
        {bodyContent}
      </SheetContent>
    </Sheet>
  );
}

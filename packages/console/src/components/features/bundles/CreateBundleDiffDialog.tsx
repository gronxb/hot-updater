import type { Bundle } from "@hot-updater/plugin-core";
import { GitBranchPlus, Layers3 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { BundleIdDisplay } from "@/components/BundleIdDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBundlesQuery, useCreateBundleDiffMutation } from "@/lib/api";

interface CreateBundleDiffDialogProps {
  bundle: Bundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatBundleOption = (bundle: Bundle) => {
  const label =
    bundle.message?.trim() || bundle.targetAppVersion || bundle.channel;
  return `${bundle.id.slice(0, 8)} · ${label}`;
};

export function CreateBundleDiffDialog({
  bundle,
  open,
  onOpenChange,
}: CreateBundleDiffDialogProps) {
  const createBundleDiffMutation = useCreateBundleDiffMutation();
  const [baseBundleId, setBaseBundleId] = useState("");

  const { data: bundlesData } = useBundlesQuery({
    channel: bundle.channel,
    platform: bundle.platform,
    limit: "200",
    page: 1,
  });

  const baseCandidates = (bundlesData?.data ?? []).filter(
    (candidate) =>
      candidate.id !== bundle.id && candidate.id.localeCompare(bundle.id) < 0,
  );
  const selectedBaseBundle =
    baseCandidates.find((candidate) => candidate.id === baseBundleId) ?? null;
  const currentBaseBundleId = bundle.metadata?.diff_base_bundle_id ?? "";
  const quickCandidates = baseCandidates.slice(0, 3);

  useEffect(() => {
    if (!open) {
      setBaseBundleId("");
      return;
    }

    if (currentBaseBundleId) {
      setBaseBundleId(currentBaseBundleId);
      return;
    }

    setBaseBundleId(baseCandidates[0]?.id ?? "");
  }, [baseCandidates, currentBaseBundleId, open]);

  const handleSubmit = async () => {
    if (!baseBundleId) {
      toast.error("Select a Base Bundle First");
      return;
    }

    try {
      await createBundleDiffMutation.mutateAsync({
        baseBundleId,
        bundleId: bundle.id,
      });
      toast.success("BSDIFF Patch Created", {
        description: `base: ${baseBundleId.slice(0, 8)} -> target: ${bundle.id.slice(0, 8)}`,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to create BSDIFF patch",
      );
      console.error(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create BSDIFF Patch</DialogTitle>
          <DialogDescription>
            Pick an older bundle as the base. The console generates a Hermes
            BSDIFF patch, uploads it, and attaches the metadata to this target
            bundle.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          <div className="rounded-xl border bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg border bg-background p-2 text-muted-foreground">
                <Layers3 className="h-4 w-4" />
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Target Bundle
                  </p>
                  <BundleIdDisplay bundleId={bundle.id} maxLength={18} />
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <GitBranchPlus className="h-3.5 w-3.5" />
                  {selectedBaseBundle ? (
                    <span>
                      base {selectedBaseBundle.id.slice(0, 8)} to target{" "}
                      {bundle.id.slice(0, 8)}
                    </span>
                  ) : (
                    <span>Select a base bundle to build the stack</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="bundle-diff-base">Base Bundle</Label>
            <Select value={baseBundleId} onValueChange={setBaseBundleId}>
              <SelectTrigger id="bundle-diff-base">
                <SelectValue placeholder="Select an older bundle" />
              </SelectTrigger>
              <SelectContent>
                {baseCandidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {formatBundleOption(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {baseCandidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No older bundles are available in the current channel/platform
                view.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only older bundles on the same platform are eligible as a diff
                base.
              </p>
            )}
          </div>

          {quickCandidates.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Recent Base Candidates
              </p>
              <div className="flex flex-wrap gap-2">
                {quickCandidates.map((candidate) => (
                  <Button
                    key={candidate.id}
                    type="button"
                    variant={
                      candidate.id === baseBundleId ? "default" : "outline"
                    }
                    size="xs"
                    onClick={() => setBaseBundleId(candidate.id)}
                  >
                    {candidate.id.slice(0, 8)}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!baseBundleId || createBundleDiffMutation.isPending}
          >
            {createBundleDiffMutation.isPending
              ? "Creating Patch…"
              : "Create Patch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

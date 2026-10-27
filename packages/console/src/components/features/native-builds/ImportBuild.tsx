import { ArrowUpRight, FileUp } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { CopyableText } from "./CopyableText";

/** The command that tracks a build made elsewhere. */
export const IMPORT_COMMAND =
  "npx hot-updater native-build import <path-to-.ipa|.aab|.apk>";

const IMPORT_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#import-a-build-made-elsewhere";

/**
 * How to track a build made elsewhere: the CLI command, which reads the
 * artifact on the machine that has it. The Console uploads nothing, since a
 * host may cap a request's body far below an `.ipa`.
 */
export function ImportBuildSteps() {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Track an <code className="font-mono">.ipa</code>,{" "}
        <code className="font-mono">.aab</code> or{" "}
        <code className="font-mono">.apk</code> built elsewhere, such as by EAS,
        Xcode Cloud or Fastlane, so the OTAs you deploy after it patch from its
        built-in bundle. Run in the app's project:
      </p>
      <CopyableText label="the import command" value={IMPORT_COMMAND} />
    </div>
  );
}

/** The toolbar's "Import a build" button and the command it shows. */
export function ImportBuildDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            aria-label="Import a build"
            className="min-h-11 sm:min-h-7"
            size="sm"
            variant="outline"
          />
        }
      >
        <FileUp data-icon="inline-start" />
        <span className="hidden sm:inline">Import a build</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a build</DialogTitle>
          <DialogDescription>
            The build appears here once the command tracks it.
          </DialogDescription>
        </DialogHeader>
        <ImportBuildSteps />
        <a
          className={buttonVariants({
            className: "min-h-11 w-full sm:min-h-8 sm:w-fit",
            variant: "outline",
          })}
          href={IMPORT_GUIDE_URL}
          rel="noreferrer"
          target="_blank"
        >
          Import guide
          <ArrowUpRight data-icon="inline-end" />
        </a>
      </DialogContent>
    </Dialog>
  );
}

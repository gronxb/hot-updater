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
export const IMPORT_COMMAND = "npx hot-updater native-build import <file>";

/** `native-build import`'s section of the native build guide. */
export const IMPORT_GUIDE_URL =
  "https://hot-updater.dev/docs/guides/native-build#import-a-build-made-elsewhere";

/**
 * The toolbar's "Import a build" button and the command it shows: the CLI
 * reads the artifact on the machine that has it, so the Console uploads
 * nothing, since a host may cap a request's body far below an `.ipa`. The
 * guide has the rest, such as `--channel`.
 */
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
            Track an .ipa, .aab, .apk or .app built elsewhere as a patch base.
          </DialogDescription>
        </DialogHeader>
        <CopyableText label="the import command" value={IMPORT_COMMAND} wrap />
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

import type { Bundle } from "@hot-updater/plugin-core";
import { CloseButton as AlertDialogCloseButton } from "@kobalte/core/alert-dialog";
import { useSearchParams } from "@solidjs/router";
import { useQueryClient } from "@tanstack/solid-query";
import { Hash } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Callout, CalloutContent } from "@/components/ui/callout";
import {
  Combobox,
  ComboboxContent,
  ComboboxControl,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxItemLabel,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { TextField, TextFieldLabel } from "@/components/ui/text-field";
import { showToast } from "@/components/ui/toast";
import { api, useChannelsQuery } from "@/lib/api";
import { createUUIDv7WithSameTimestamp } from "@/lib/extract-timestamp-from-uuidv7";

export interface PromoteChannelDialogProps {
  bundle: Bundle;
}

export const PromoteChannelDialog = ({ bundle }: PromoteChannelDialogProps) => {
  const queryClient = useQueryClient();
  const channels = useChannelsQuery();
  const [, setSearchParams] = useSearchParams();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [selectedChannel, setSelectedChannel] = createSignal(bundle.channel);
  const [open, setOpen] = createSignal(false);
  const [shouldCopy, setShouldCopy] = createSignal(false);

  const handlePrompt = async () => {
    setIsSubmitting(true);
    try {
      if (shouldCopy()) {
        // Copy: Create new bundle with new ID (preserving timestamp) and target channel
        const newBundle: Bundle = {
          ...bundle,
          id: createUUIDv7WithSameTimestamp(bundle.id),
          channel: selectedChannel(),
        };

        const res = await api.bundles.$post({
          json: newBundle,
        });

        if (res.status !== 200) {
          const json = await res.json();
          if ("error" in json) {
            showToast({
              title: "Error",
              description: json.error,
              variant: "error",
            });
          }
          return;
        }

        showToast({
          title: "Success",
          description: `Created new bundle ${newBundle.id} in ${selectedChannel()}`,
          variant: "success",
        });

        // Navigate to the new copied bundle
        setSearchParams({
          bundleId: undefined,
          channel: selectedChannel(),
        });
      } else {
        // Move: Update existing bundle's channel
        const res = await api.bundles[":bundleId"].$patch({
          param: { bundleId: bundle.id },
          json: { channel: selectedChannel() },
        });

        if (res.status !== 200) {
          const json = (await res.json()) as { error: string };
          showToast({
            title: "Error",
            description: json.error,
            variant: "error",
          });
          return;
        }

        showToast({
          title: "Success",
          description: `Moved bundle ${bundle.id} to ${selectedChannel()}`,
          variant: "success",
        });

        // Navigate to the moved bundle in its new channel
        setSearchParams({
          bundleId: bundle.id,
          channel: selectedChannel(),
        });
      }

      queryClient.invalidateQueries({ queryKey: ["bundle", bundle.id] });
      queryClient.invalidateQueries({ queryKey: ["bundles"] });
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      setTimeout(() => setOpen(false), 100);
    } catch (e) {
      if (e instanceof Error) {
        showToast({
          title: "Error",
          description: e.message,
          variant: "error",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open()} onOpenChange={setOpen}>
      <AlertDialogTrigger
        as={Button}
        variant="outline"
        size="sm"
        class="gap-2 w-full"
      >
        <Hash class="h-4 w-4" />
        Promote Channel
      </AlertDialogTrigger>
      <AlertDialogOverlay />
      <AlertDialogContent>
        <AlertDialogTitle>Promote Channel</AlertDialogTitle>
        <AlertDialogDescription>
          Select or enter a new channel for this bundle. Choose whether to copy
          the bundle (keeps it in the original channel) or move it (removes from
          the original channel).
        </AlertDialogDescription>
        <div class="mt-4 space-y-4">
          <Switch checked={shouldCopy()} onChange={setShouldCopy}>
            <div class="flex items-center justify-between">
              <div class="space-y-0.5">
                <SwitchLabel class="text-base">
                  {shouldCopy() ? "Copy bundle" : "Move bundle"}
                </SwitchLabel>
                <div class="text-sm text-muted-foreground">
                  {shouldCopy()
                    ? "Keep original + create copy in target channel"
                    : "Move to target channel (removes from current)"}
                </div>
              </div>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </div>
          </Switch>
          <Show when={shouldCopy()}>
            <Callout variant="default">
              <CalloutContent class="mt-0 text-sm">
                The copied bundle will have a new database ID that differs from
                the bundle ID inside the JavaScript bundle.
              </CalloutContent>
            </Callout>
          </Show>
          <TextField class="grid w-full items-center gap-1.5">
            <TextFieldLabel for="channel">Channel</TextFieldLabel>
            <Combobox
              defaultValue={selectedChannel()}
              options={channels.data ?? []}
              onChange={(value) => value && setSelectedChannel(value)}
              onInputChange={(value) => {
                setSelectedChannel(value);
              }}
              placeholder="Enter or select a channel..."
              itemComponent={(props) => (
                <ComboboxItem item={props.item}>
                  <ComboboxItemLabel>{props.item.rawValue}</ComboboxItemLabel>
                  <ComboboxItemIndicator />
                </ComboboxItem>
              )}
            >
              <ComboboxControl aria-label="Channel">
                <ComboboxInput />
                <ComboboxTrigger />
              </ComboboxControl>
              <ComboboxContent />
            </Combobox>
          </TextField>
        </div>
        <div class="flex gap-2 justify-end mt-4">
          <AlertDialogCloseButton as={Button} variant="outline" size="sm">
            Cancel
          </AlertDialogCloseButton>
          <Button
            variant="default"
            size="sm"
            onClick={handlePrompt}
            disabled={isSubmitting() || !selectedChannel()}
            class="gap-2"
          >
            <Show when={isSubmitting()} fallback={<Hash class="h-4 w-4" />}>
              <div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </Show>
            {isSubmitting()
              ? shouldCopy()
                ? "Copying..."
                : "Moving..."
              : shouldCopy()
                ? "Copy"
                : "Move"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};

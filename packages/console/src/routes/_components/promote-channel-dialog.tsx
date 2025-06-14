import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import { TextField, TextFieldLabel } from "@/components/ui/text-field";
import { showToast } from "@/components/ui/toast";
import { api, createChannelsQuery } from "@/lib/api";
import type { Bundle } from "@hot-updater/plugin-core";
import { CloseButton as AlertDialogCloseButton } from "@kobalte/core/alert-dialog";
import { useQueryClient } from "@tanstack/solid-query";
import { Hash } from "lucide-solid";
import { Show, createSignal } from "solid-js";

export interface PromoteChannelDialogProps {
  bundle: Bundle;
}

export const PromoteChannelDialog = ({ bundle }: PromoteChannelDialogProps) => {
  const queryClient = useQueryClient();
  const channels = createChannelsQuery();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [selectedChannel, setSelectedChannel] = createSignal(bundle.channel);
  const [open, setOpen] = createSignal(false);

  const handlePrompt = async () => {
    setIsSubmitting(true);
    try {
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
      } else {
        showToast({
          title: "Success",
          description: "Channel updated successfully",
          variant: "success",
        });
        queryClient.invalidateQueries({ queryKey: ["bundle", bundle.id] });
        queryClient.invalidateQueries({ queryKey: ["bundles"] });
        queryClient.invalidateQueries({ queryKey: ["channels"] });
        setTimeout(() => setOpen(false), 100);
      }
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
        class="gap-2 flex-1"
      >
        <Hash class="h-4 w-4" />
        Promote Channel
      </AlertDialogTrigger>
      <AlertDialogOverlay />
      <AlertDialogContent>
        <AlertDialogTitle>Promote Channel</AlertDialogTitle>
        <AlertDialogDescription>
          Select or enter a new channel for this bundle.
        </AlertDialogDescription>
        <div class="mt-4">
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
            {isSubmitting() ? "Updating..." : "Prompt"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};

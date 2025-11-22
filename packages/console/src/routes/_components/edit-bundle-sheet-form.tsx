import type { Bundle } from "@hot-updater/core";
import { createForm } from "@tanstack/solid-form";
import { useQueryClient } from "@tanstack/solid-query";
import { LoaderCircle } from "lucide-solid";
import semverValid from "semver/ranges/valid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { createMemo, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui/text-field";
import { showToast } from "@/components/ui/toast";
import { useBundleUpdateMutation, useConfigQuery } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface EditBundleSheetFormProps {
  bundle: Bundle;
  onEditSuccess: () => void;
}

export const EditBundleSheetForm = ({
  bundle,
  onEditSuccess,
}: EditBundleSheetFormProps) => {
  const queryClient = useQueryClient();
  const config = useConfigQuery();
  const updateMutation = useBundleUpdateMutation();

  const gitUrl = createMemo(() => config.data?.console?.gitUrl ?? null);
  const gitCommitHash = createMemo(() => bundle.gitCommitHash);

  const form = createForm(() => ({
    defaultValues: {
      message: bundle.message,
      targetAppVersion: bundle.targetAppVersion,
      enabled: bundle.enabled,
      shouldForceUpdate: bundle.shouldForceUpdate,
    } as Partial<Bundle>,
    onSubmit: async ({ value }) => {
      try {
        await updateMutation.mutateAsync({ bundleId: bundle.id, data: value });
        queryClient.invalidateQueries({ queryKey: ["bundle", bundle.id] });
        queryClient.invalidateQueries({ queryKey: ["bundles"] });
        queryClient.invalidateQueries({ queryKey: ["channels"] });
        onEditSuccess();
      } catch (e) {
        if (e instanceof Error) {
          showToast({
            title: "Error",
            description: e.message,
            variant: "error",
          });
        }
      }
    },
  }));

  const isValid = form.useStore((state) => state.isValid);

  return (
    <form
      class="flex flex-col gap-3 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="message">Message</TextFieldLabel>
          <form.Field name="message">
            {(field) => (
              <TextFieldInput
                type="text"
                id="message"
                placeholder="Message"
                name={field().name}
                value={field().state.value ?? ""}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

      <Show when={bundle.targetAppVersion}>
        <div>
          <TextField class="grid w-full max-w-sm items-center gap-1.5">
            <TextFieldLabel for="targetAppVersion">
              Target App Version
            </TextFieldLabel>
            <form.Field
              name="targetAppVersion"
              validators={{
                onChange: ({ value }) => {
                  if (value?.length === 0 || !semverValid(value)) {
                    return "Invalid target app version";
                  }

                  return undefined;
                },
              }}
            >
              {(field) => (
                <>
                  <TextFieldInput
                    type="text"
                    id="targetAppVersion"
                    class={cn(
                      field().state.meta.errors.length > 0 &&
                        "border-red-500 focus-visible:ring-red-500",
                    )}
                    placeholder="Target App Version"
                    name={field().name}
                    value={field().state.value ?? ""}
                    onBlur={field().handleBlur}
                    onInput={(e) => field().handleChange(e.currentTarget.value)}
                  />
                  {field().state.meta.errors.length > 0 ? (
                    <em class="text-xs text-red-500">
                      {field().state.meta.errors.join(", ")}
                    </em>
                  ) : (
                    <em class="text-xs text-muted-foreground">
                      {semverValid(field().state.value)}
                    </em>
                  )}
                </>
              )}
            </form.Field>
          </TextField>
        </div>
      </Show>

      <Show when={bundle.fingerprintHash}>
        <div>
          <TextField class="grid w-full max-w-sm items-center gap-1.5">
            <TextFieldLabel for="fingerprintHash">
              Fingerprint Hash
            </TextFieldLabel>
            <TextFieldInput
              type="text"
              id="fingerprintHash"
              value={bundle.fingerprintHash ?? ""}
              disabled
            />
          </TextField>
        </div>
      </Show>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="enabled">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Enabled</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When disabled, this update will not be available to your users.
        </p>
      </div>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="shouldForceUpdate">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Force Update</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>
      </div>

      <Show
        when={!updateMutation.isPending}
        fallback={
          <Button type="submit" class="mt-4" disabled>
            <LoaderCircle class="animate-spin" />
          </Button>
        }
      >
        <Button type="submit" class="mt-4" disabled={!isValid()}>
          Save
        </Button>
      </Show>

      <div class="mt-2 space-y-1">
        <h3 class="text-md text-bold font-medium">Metadata</h3>
        <Show when={bundle.platform === "ios"}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Platform:{" "}
            <p class="ml-2 flex flex-row items-center">
              <AiFillApple class="inline-block" /> iOS
            </p>
          </div>
        </Show>
        <Show when={bundle.platform === "android"}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Platform:{" "}
            <p class="ml-2 flex flex-row items-center">
              <AiFillAndroid class="inline-block" /> Android
            </p>
          </div>
        </Show>
        <Show when={bundle.metadata?.app_version}>
          {(appVersion) => (
            <div class="text-sm text-muted-foreground flex flex-row items-center">
              App Version: <p class="ml-2">{appVersion()}</p>
            </div>
          )}
        </Show>
        <Show when={bundle.channel}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Channel: <p class="ml-2">{bundle.channel}</p>
          </div>
        </Show>

        <Show when={gitCommitHash()}>
          {(gitCommitHash) => (
            <div class="text-sm text-muted-foreground flex flex-row items-center">
              Commit Hash:{" "}
              {gitUrl() ? (
                <a
                  href={`${gitUrl()}/commit/${gitCommitHash}`}
                  target="_blank"
                  rel="noreferrer"
                  class="ml-2"
                >
                  {gitCommitHash().slice(0, 8)}
                </a>
              ) : (
                <p class="ml-2">{gitCommitHash().slice(0, 8)}</p>
              )}
            </div>
          )}
        </Show>
      </div>
    </form>
  );
};

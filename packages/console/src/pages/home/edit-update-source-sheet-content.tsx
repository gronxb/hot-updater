import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { trpc } from "@/lib/trpc";
import type { UpdateSource } from "@hot-updater/utils";
import { Controller, useForm } from "react-hook-form";

interface EditUpdateSourceSheetFormProps {
  source: UpdateSource;
  onEditSuccess: () => void;
}

const EditUpdateSourceSheetForm = ({
  source,
  onEditSuccess,
}: EditUpdateSourceSheetFormProps) => {
  const utils = trpc.useUtils();
  const { mutate: updateSource } = trpc.updateUpdateSource.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.getUpdateSourceByBundleVersion.invalidate({
          bundleVersion: source.bundleVersion,
        }),
        utils.updateSources.invalidate(),
      ]);
      toast({
        title: "Update source updated",
        description: "Your update source has been updated",
      });
      onEditSuccess();
    },
  });

  const { control, register, handleSubmit } = useForm({
    defaultValues: {
      description: source.description,
      targetVersion: source.targetVersion,
      enabled: source.enabled,
      forceUpdate: source.forceUpdate,
    },
  });

  const onSubmit = (data: Partial<UpdateSource>) => {
    updateSource({
      targetBundleVersion: source.bundleVersion,
      updateSource: data,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor="description">Description</Label>
        <Input id="description" {...register("description")} />
      </div>

      <div>
        <Label htmlFor="targetVersion">Target Version</Label>
        <Input id="targetVersion" {...register("targetVersion")} />
      </div>

      <div>
        <div className="flex items-center space-x-2">
          <Label htmlFor="enabled" className="w-24 font-bold">
            Enabled
          </Label>
          <Controller
            name="enabled"
            control={control}
            render={({ field }) => (
              <Switch
                id="enabled"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-[2px]">
          When disabled, this update will not be available to your users.
        </p>
      </div>

      <div>
        <div className="flex items-center space-x-2">
          <Label htmlFor="forceUpdate" className="w-24 font-bold">
            Force Update
          </Label>
          <Controller
            name="forceUpdate"
            control={control}
            render={({ field }) => (
              <Switch
                id="forceUpdate"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-[2px]">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>
      </div>
      <Button onClick={handleSubmit(onSubmit)} className="mt-4">
        Save
      </Button>
    </div>
  );
};

export interface EditUpdateSourceSheetContentProps {
  bundleVersion: number;
  onClose: () => void;
}

export const EditUpdateSourceSheetContent = ({
  bundleVersion,
  onClose,
}: EditUpdateSourceSheetContentProps) => {
  const { data: source } = trpc.getUpdateSourceByBundleVersion.useQuery({
    bundleVersion,
  });

  return (
    <SheetContent className="flex flex-col h-full">
      <SheetHeader className="mb-4">
        <SheetTitle>Edit {source?.bundleVersion}</SheetTitle>
      </SheetHeader>

      {source ? (
        <EditUpdateSourceSheetForm source={source} onEditSuccess={onClose} />
      ) : (
        <SheetDescription>
          No update source found for bundle version {bundleVersion}
        </SheetDescription>
      )}
    </SheetContent>
  );
};

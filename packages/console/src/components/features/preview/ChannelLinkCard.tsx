import { createChannelLink } from "@hot-updater/protocol";
import { ArrowUpRight, ExternalLink, Link2 } from "lucide-react";

import { QrCode } from "@/components/QrCode";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { androidOpenLinkCommand, iosOpenLinkCommand } from "@/lib/shell";

import { CopyableText } from "./CopyableText";

const PREVIEW_GUIDE_URL = "https://hot-updater.dev/docs/guides/preview-builds";

/**
 * A channel's link, `<prefix>hot-updater/channel/<channel>`, as a QR code
 * and the commands that open it on an emulator or simulator. A preview
 * build opens it with `hotUpdater.openChannelLink` and switches to the
 * channel's bundle.
 */
export function ChannelLinkCard({
  prefix,
  prefixPending,
  channels,
  channel,
  onChannelChange,
}: {
  /** `console.channelLinkPrefix`, or undefined when the config sets none. */
  readonly prefix: string | undefined;
  /** Whether the console's config is still loading. */
  readonly prefixPending: boolean;
  readonly channels: {
    readonly data: readonly string[] | undefined;
    readonly isError: boolean;
    readonly isPending: boolean;
    readonly refetch: () => unknown;
  };
  readonly channel: string | undefined;
  readonly onChannelChange: (channel: string) => void;
}) {
  const link =
    prefix === undefined || channel === undefined
      ? undefined
      : createChannelLink(prefix, channel);

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Channel link</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 sm:p-6">
        {prefixPending ? (
          <div className="grid gap-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <span className="sr-only">Loading the channel link</span>
            <Skeleton className="size-48" />
            <Skeleton className="h-11 w-full sm:h-9" />
          </div>
        ) : prefix === undefined ? (
          <Empty className="p-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Link2 />
              </EmptyMedia>
              <EmptyTitle>Set the app's link prefix</EmptyTitle>
              <EmptyDescription>
                Add <code className="font-mono">console.channelLinkPrefix</code>
                , such as <code className="font-mono">"myapp://"</code>, to show
                a QR code that switches a preview build to a channel.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <a
                className={buttonVariants({
                  className: "min-h-11 sm:min-h-8",
                  variant: "outline",
                })}
                href={PREVIEW_GUIDE_URL}
                rel="noreferrer"
                target="_blank"
              >
                Preview builds guide
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div className="flex flex-col items-center gap-2">
              {link === undefined ? (
                <div className="flex size-48 items-center justify-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Choose a channel to show its QR code.
                </div>
              ) : (
                <QrCode
                  className="size-48"
                  label={`Switch to the ${channel} channel`}
                  value={link}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="preview-channel">Channel</FieldLabel>
                {channels.isPending ? (
                  <Skeleton className="h-11 w-full sm:h-9" />
                ) : (
                  <Combobox
                    items={channels.data ?? []}
                    // A pull request's channel appears while the page is
                    // open, so opening the list reads the channels again.
                    onOpenChange={(open) => {
                      if (open) void channels.refetch();
                    }}
                    onValueChange={(value) => {
                      if (value !== null) onChannelChange(value);
                    }}
                    value={channel ?? null}
                  >
                    <ComboboxInput
                      className="h-11 w-full sm:h-9 [&_input]:h-full"
                      id="preview-channel"
                      maxLength={1024}
                      placeholder="Search channels…"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>
                        {channels.isError ? (
                          <div className="flex flex-col items-center gap-2 p-2">
                            Couldn't load channels.
                            <Button
                              onClick={() => void channels.refetch()}
                              size="sm"
                              variant="outline"
                            >
                              Retry channels
                            </Button>
                          </div>
                        ) : (
                          "No channels found."
                        )}
                      </ComboboxEmpty>
                      <ComboboxList>
                        {(item: string) => (
                          <ComboboxItem
                            className="min-h-11 pr-8 sm:min-h-8"
                            key={item}
                            value={item}
                          >
                            <span className="truncate">{item}</span>
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                )}
              </Field>
              {link === undefined ? (
                <p className="text-xs text-muted-foreground">
                  Each pull request deploys to its own channel. Scanning its
                  link in a preview build loads its bundle; production builds
                  ignore the link.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Scan it with the phone's camera, or open it on this device:
                  </p>
                  <a
                    className={buttonVariants({
                      className: "min-h-11 w-full sm:min-h-8 sm:w-fit",
                      variant: "outline",
                    })}
                    href={link}
                  >
                    <ExternalLink data-icon="inline-start" />
                    Open in the app
                  </a>
                  <p className="pt-2 text-xs text-muted-foreground">
                    On an Android emulator:
                  </p>
                  <CopyableText
                    label="the Android command"
                    value={androidOpenLinkCommand(link)}
                  />
                  <p className="pt-2 text-xs text-muted-foreground">
                    On the booted iOS Simulator:
                  </p>
                  <CopyableText
                    label="the iOS Simulator command"
                    value={iosOpenLinkCommand(link)}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

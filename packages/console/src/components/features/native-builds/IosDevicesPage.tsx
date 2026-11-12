import {
  extractTimestampFromUUIDv7,
  type IosDeviceRow,
  type IosDeviceStatus,
} from "@hot-updater/plugin-core";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import {
  AlertTriangle,
  Check,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  DataCard,
  DataCardSkeletons,
  DataCardsEmpty,
  DataTable,
  DataTableEmpty,
  DataTableFrame,
  DataTableFullRow,
  DataTableSkeletonRows,
} from "@/components/DataTable";
import { QrCode } from "@/components/QrCode";
import { RelativeTime } from "@/components/RelativeTime";
import { NoValue } from "@/components/TargetDisplay";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  iosDeviceKeys,
  useApproveIosDeviceMutation,
  keptIsThisIphone,
  useIosDeviceProfileLinkQuery,
  useIosDeviceQuery,
  useKeptIosDeviceQuery,
  useRequestThisIphoneMutation,
  useIosDevicesQuery,
  useRemoveIosDeviceMutation,
  useRenameIosDeviceMutation,
} from "@/lib/ios-devices-api";
import type { IosDevicesView } from "@/lib/ios-devices-rpc";
import {
  consolePathOf,
  IOS_DEVICES_ADD_COMMAND,
  IOS_DEVICES_PATH,
  iosDeviceProfileUrl,
  maskIosUdid,
} from "@/lib/native-builds";
import type { IosDevicesSearch } from "@/routes/-native-builds-search";

import { CopyableText } from "./CopyableText";
import {
  AppleRefusal,
  type IosDevice,
  useAdoptKeptIosDevice,
  useIosDevice,
} from "./IosInstall";
import { NativeBuildsNav } from "./NativeBuildsNav";

const STATUS_LABELS: Record<IosDeviceStatus, string> = {
  pending: "Requested",
  approved: "Approved",
  registered: "Registered",
};

/**
 * Only a request waits on someone, so only it takes a status color; the
 * other states are the normal course and stay neutral.
 */
const STATUS_BADGES: Record<
  IosDeviceStatus,
  "warning" | "secondary" | "muted"
> = {
  pending: "warning",
  approved: "secondary",
  registered: "muted",
};

const ALL = "all";
const COLUMNS = 6;

type Viewer = IosDevicesView["viewer"];

/** The Console's path from this page, so links work under a base path. */
const consolePath = () =>
  window.location.pathname.endsWith(IOS_DEVICES_PATH)
    ? window.location.pathname.slice(0, -IOS_DEVICES_PATH.length)
    : consolePathOf(window.location, "");

/** Who may act on a row, decided again on the server. */
const actionsFor = (device: IosDeviceRow, viewer: Viewer) => ({
  approve: viewer.canApprove && device.status === "pending",
  rename: viewer.canApprove,
  remove: viewer.canApprove,
  withdraw:
    !viewer.canApprove &&
    device.status === "pending" &&
    device.requested_by === viewer.email,
});

/**
 * Apple's refusal of an approved device is the row an approver acts on, so it
 * takes the warning in place of Approved; the other states stay neutral.
 */
const appleRefused = (device: IosDeviceRow) =>
  device.status === "approved" && device.apple_error !== null;

/** Who asked for a device: a person, or a terminal for one the CLI added. */
const requesterOf = (device: IosDeviceRow) =>
  device.requested_by ?? "Added from a terminal";

/**
 * Apple's reason. In a table cell it wraps at most two lines in a narrow
 * column, the full text on hover and to a screen reader, so a long reason
 * never widens the table past its frame; a card shows all of it.
 */
function AppleError({
  device,
  inTable = false,
}: {
  readonly device: IosDeviceRow;
  readonly inTable?: boolean;
}) {
  if (device.apple_error === null) return null;
  return inTable ? (
    <span
      className="line-clamp-2 max-w-48 text-xs whitespace-normal text-muted-foreground"
      title={device.apple_error}
    >
      {device.apple_error}
    </span>
  ) : (
    <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">
      {device.apple_error}
    </span>
  );
}

function DeviceStatus({
  device,
  withError = true,
}: {
  readonly device: IosDeviceRow;
  /** Apple's reason under the badge; a card shows it on its own line. */
  readonly withError?: boolean;
}) {
  return (
    <div className="flex min-w-0 shrink-0 flex-col items-start gap-1">
      {appleRefused(device) ? (
        <Badge variant="warning">Apple refused</Badge>
      ) : (
        <Badge variant={STATUS_BADGES[device.status]}>
          {STATUS_LABELS[device.status]}
        </Badge>
      )}
      {withError ? <AppleError device={device} inTable /> : null}
    </div>
  );
}

function DeviceBuild({ device }: { readonly device: IosDeviceRow }) {
  if (device.build_id === null) {
    return <NoValue />;
  }
  let label = "A build";
  try {
    label = `Build of ${dayjs(extractTimestampFromUUIDv7(device.build_id)).format("MMM D")}`;
  } catch {
    // An ID that isn't a UUIDv7 keeps the plain label.
  }
  return (
    <Link
      className="text-xs font-medium underline-offset-4 hover:underline"
      params={{ buildId: device.build_id }}
      to="/native-builds/$buildId"
    >
      {label}
    </Link>
  );
}

type NameTarget = {
  readonly kind: "approve" | "rename";
  readonly device: IosDeviceRow;
};
type DialogTarget =
  | NameTarget
  | { readonly kind: "remove"; readonly device: IosDeviceRow }
  | null;

function DeviceActions({
  device,
  viewer,
  onOpen,
}: {
  readonly device: IosDeviceRow;
  readonly viewer: Viewer;
  readonly onOpen: (target: DialogTarget) => void;
}) {
  const can = actionsFor(device, viewer);
  if (!can.approve && !can.rename && !can.remove && !can.withdraw) return null;
  return (
    <div className="flex items-center justify-end gap-1">
      {can.approve ? (
        <Button
          className="h-11 sm:h-8"
          onClick={() => onOpen({ kind: "approve", device })}
          size="sm"
        >
          <Check data-icon="inline-start" />
          Approve
        </Button>
      ) : null}
      {can.withdraw ? (
        <Button
          className="h-11 sm:h-8"
          onClick={() => onOpen({ kind: "remove", device })}
          size="sm"
          variant="outline"
        >
          Withdraw
        </Button>
      ) : null}
      {can.rename || can.remove ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`More actions for ${device.name}`}
                className="size-11 sm:size-8"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onOpen({ kind: "rename", device })}
            >
              <Pencil aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onOpen({ kind: "remove", device })}
              variant="destructive"
            >
              <Trash2 aria-hidden="true" />
              {device.status === "pending" ? "Decline" : "Remove"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/**
 * "This iPhone" on the row of the iPhone this page is open on: a quiet tag,
 * as "Sandbox" is on a build, so its actions are found where every row's are.
 */
function ThisIphoneTag() {
  return (
    <Badge className="shrink-0 px-1.5" variant="muted">
      This iPhone
    </Badge>
  );
}

function DeviceRow({
  device,
  viewer,
  onOpen,
  isThisIphone,
}: {
  readonly device: IosDeviceRow;
  readonly viewer: Viewer;
  readonly onOpen: (target: DialogTarget) => void;
  readonly isThisIphone: boolean;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="flex items-center gap-1.5">
          {device.name}
          {isThisIphone ? <ThisIphoneTag /> : null}
        </span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs" title={device.udid} translate="no">
          {maskIosUdid(device.udid)}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        {device.requested_by ?? (
          <span className="text-muted-foreground">{requesterOf(device)}</span>
        )}
      </TableCell>
      <TableCell>
        <DeviceStatus device={device} />
      </TableCell>
      <TableCell className="text-xs">
        <RelativeTime ms={device.created_at_ms} />
      </TableCell>
      <TableCell>
        <DeviceBuild device={device} />
      </TableCell>
      <TableCell className="text-right">
        <DeviceActions device={device} onOpen={onOpen} viewer={viewer} />
      </TableCell>
    </TableRow>
  );
}

function DeviceCard({
  device,
  viewer,
  onOpen,
  isThisIphone,
}: {
  readonly device: IosDeviceRow;
  readonly viewer: Viewer;
  readonly onOpen: (target: DialogTarget) => void;
  readonly isThisIphone: boolean;
}) {
  return (
    <DataCard className="cursor-default gap-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{device.name}</span>
            {isThisIphone ? <ThisIphoneTag /> : null}
          </p>
          <p className="font-mono text-xs text-muted-foreground" translate="no">
            {maskIosUdid(device.udid)}
          </p>
        </div>
        <DeviceStatus device={device} withError={false} />
      </div>
      <AppleError device={device} />
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{requesterOf(device)}</span>
        <span aria-hidden="true">·</span>
        <RelativeTime ms={device.created_at_ms} />
        {device.build_id === null ? null : (
          <>
            <span aria-hidden="true">·</span>
            <DeviceBuild device={device} />
          </>
        )}
      </p>
      <DeviceActions device={device} onOpen={onOpen} viewer={viewer} />
    </DataCard>
  );
}

/** Name a device: approving a request, or renaming any device. */
function NameDialog({
  target,
  onClose,
}: {
  readonly target: NameTarget;
  readonly onClose: () => void;
}) {
  const approve = useApproveIosDeviceMutation();
  const rename = useRenameIosDeviceMutation();
  const mutation = target.kind === "approve" ? approve : rename;
  const [name, setName] = useState(target.device.name);
  const trimmed = name.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "") return;
    mutation.mutate(
      { id: target.device.id, name: trimmed },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target.kind === "approve"
              ? `Approve ${target.device.name}?`
              : `Rename ${target.device.name}`}
          </DialogTitle>
          <DialogDescription>
            {target.kind === "approve"
              ? "The next ad hoc build registers this iPhone with your Apple account. Each new iPhone uses one of the account's 100 a year, and removing it never gives the slot back."
              : "The registry shows this name. The next ad hoc build doesn't rename it at Apple."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            {target.kind === "approve" ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Requested by</dt>
                <dd className="truncate">
                  {target.device.requested_by ?? "Terminal (CLI)"}
                </dd>
                <dt className="text-muted-foreground">UDID</dt>
                {/* All of it, to check against Finder: a phone has no hover. */}
                <dd
                  className="font-mono text-xs break-all select-all"
                  translate="no"
                >
                  {target.device.udid}
                </dd>
              </dl>
            ) : null}
            <Field data-invalid={mutation.isError || undefined}>
              <FieldLabel htmlFor="ios-device-dialog-name">Name</FieldLabel>
              <Input
                autoComplete="off"
                id="ios-device-dialog-name"
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              {target.kind === "approve" ? (
                <FieldDescription>
                  The iPhone's ID comes from the person who asked. Approve
                  devices you recognize.
                </FieldDescription>
              ) : null}
              <FieldError>
                {mutation.isError
                  ? `Couldn't ${target.kind === "approve" ? "approve" : "rename"} ${target.device.name}. Check your connection and try again.`
                  : null}
              </FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              className="h-11 sm:h-8"
              disabled={trimmed === "" || mutation.isPending}
              type="submit"
            >
              {mutation.isPending ? (
                <Loader2
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              ) : (
                <Check data-icon="inline-start" />
              )}
              {target.kind === "approve" ? "Approve" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  device,
  viewer,
  onClose,
}: {
  readonly device: IosDeviceRow;
  readonly viewer: Viewer;
  readonly onClose: () => void;
}) {
  const remove = useRemoveIosDeviceMutation();
  const withdraw = !viewer.canApprove;
  const decline = device.status === "pending";
  return (
    <AlertDialog onOpenChange={(open) => (open ? null : onClose())} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {withdraw
              ? `Withdraw ${device.name}?`
              : decline
                ? `Decline ${device.name}?`
                : `Remove ${device.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {decline
              ? "It leaves the list. Its owner can request it again."
              : "It leaves the list. New ad hoc builds keep it until it's disabled at Apple."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError ? (
          <p className="text-xs text-destructive" role="alert">
            Couldn't {withdraw ? "withdraw" : decline ? "decline" : "remove"}{" "}
            {device.name}. Check your connection and try again.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate({ udid: device.udid }, { onSuccess: onClose });
            }}
            variant="destructive"
          >
            {remove.isPending ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : null}
            {withdraw ? "Withdraw" : decline ? "Decline" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Where this iPhone stands, once its profile has answered: its row's name,
 * status, and what happens next, in place of the form that registered it.
 * It has no actions: they are on its row in the list, tagged "This iPhone",
 * as every row's are. Apple's refusal reads as on a build's page.
 */
function ThisIphone({
  device,
  viewer,
}: {
  readonly device: IosDeviceRow;
  /** Unknown until the list loads. */
  readonly viewer: Viewer | undefined;
}) {
  const canApprove = viewer?.canApprove === true;
  if (device.apple_error !== null) {
    return (
      <AppleRefusal canApprove={canApprove} device={device} onDevicesPage />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-medium">{device.name}</p>
          <p className="font-mono text-xs text-muted-foreground" translate="no">
            {maskIosUdid(device.udid)}
          </p>
        </div>
        <DeviceStatus device={device} withError={false} />
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {device.status === "pending"
          ? canApprove
            ? "Approve it below, and it joins the next ad hoc build."
            : "A maintainer approves it next."
          : device.status === "approved"
            ? "It joins the next ad hoc build."
            : "New ad hoc builds install on it."}
      </p>
    </div>
  );
}

/** Why iPhones can't register through this Console. */
function RegistrationNotice({
  status,
  secretName,
}: {
  readonly status: "local-console" | "no-secret";
  /** The secret to set, for `no-secret`. */
  readonly secretName?: string;
}) {
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {status === "local-console"
        ? "iPhones register through your hosted Console: an iPhone can't reach this computer's."
        : `Set ${secretName} on this Console to register iPhones.`}
    </p>
  );
}

/**
 * Where an iPhone joins the list: on a computer, a QR code of this page; on
 * the iPhone, its name and the profile that reads its UDID, signed for the
 * person who is signed in.
 */
function RegisterCard({
  view,
  phone,
}: {
  readonly view: IosDevicesView | undefined;
  /** This iPhone as `useIosDevice` reads it, null until the page mounts. */
  readonly phone: IosDevice | null;
}) {
  const [name, setName] = useState<string | null>(null);
  const typed = name ?? view?.defaultName ?? "";
  // The link is signed for the name as typed; a pause before signing again.
  const [signed, setSigned] = useState(typed);
  useEffect(() => {
    const timer = setTimeout(() => setSigned(typed.trim()), 400);
    return () => clearTimeout(timer);
  }, [typed]);
  const onPhone = phone?.ios === true;
  const link = useIosDeviceProfileLinkQuery(
    { mode: "register", name: signed || "iPhone" },
    onPhone && view?.registration === "ready",
  );
  const https = phone === null || window.location.protocol === "https:";
  // Once its profile has answered, this iPhone's own row, whatever the list
  // shows: after a reload, or in the tab Safari came back to.
  const udid = onPhone ? phone.udid : null;
  const mine = useIosDeviceQuery(udid);
  // A new answer with the same UDID, such as a removed iPhone registering
  // again, reads its row again: the key didn't change, so nothing else would.
  // A new UDID changes the key, which reads it; a computer reads nothing.
  const answers = phone?.answers ?? 0;
  const { refetch } = mine;
  const seen = useRef({ udid, answers });
  useEffect(() => {
    const before = seen.current;
    seen.current = { udid, answers };
    if (udid !== null && udid === before.udid && answers > before.answers) {
      void refetch();
    }
  }, [udid, answers, refetch]);
  // This Safari's proof of the iPhone, an HttpOnly cookie: the register
  // answer's fresh receipt is traded for it, and a phone with no row requests
  // itself again with it, without the profile, for the same person only.
  const path = phone === null ? "" : consolePath();
  // Also the identity of a phone whose storage Safari wiped: the cookie
  // names it, once, and the page adopts it.
  const kept = useKeptIosDeviceQuery(
    path,
    phone?.receipt ?? null,
    onPhone &&
      view?.registration === "ready" &&
      (udid === null || phone.receipt !== null || mine.data === null),
  );
  useAdoptKeptIosDevice(phone, kept.data?.udid);
  const again = useRequestThisIphoneMutation(path);
  const proved = onPhone && keptIsThisIphone(kept.data?.udid, phone.udid);

  const body = (() => {
    // The server renders this without a browser: where it is and what it is
    // are read once the page mounts.
    if (phone === null) {
      return <Skeleton aria-label="Loading" className="h-36 w-full" />;
    }
    if (onPhone && phone.udid !== null && mine.isPending) {
      return <Skeleton aria-label="Loading" className="h-36 w-full" />;
    }
    if (onPhone && mine.data) {
      return <ThisIphone device={mine.data} viewer={view?.viewer} />;
    }
    if (
      view !== undefined &&
      (view.registration === "local-console" ||
        view.registration === "no-secret")
    ) {
      return (
        <RegistrationNotice
          secretName={view.secretName}
          status={view.registration}
        />
      );
    }
    if (!onPhone) {
      return (
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <QrCode
            className="size-36 shrink-0"
            label="Open this page on an iPhone"
            value={`${window.location.origin}${consolePath()}${IOS_DEVICES_PATH}`}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">
              Open this page on the iPhone, in Safari.
            </p>
            <p className="text-xs text-muted-foreground">
              It installs a profile that reads the iPhone's ID, then lists the
              iPhone here as requested. Nothing stays installed.
            </p>
          </div>
        </div>
      );
    }
    if (!https) {
      return (
        <p className="text-xs text-muted-foreground" role="status">
          iPhones need this Console on HTTPS.
        </p>
      );
    }
    if (mine.data === null && kept.isFetching && !proved) {
      return <Skeleton aria-label="Loading" className="h-36 w-full" />;
    }
    if (proved) {
      const trimmed = typed.trim();
      return (
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            again.mutate({ name: trimmed, receipt: phone.receipt });
          }}
        >
          <Field data-invalid={again.isError || undefined}>
            <FieldLabel htmlFor="ios-device-register-name">
              This iPhone's name
            </FieldLabel>
            <Input
              autoComplete="off"
              className="h-11"
              id="ios-device-register-name"
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              value={typed}
            />
            <FieldDescription>
              This Safari checked it before, so no profile is needed.
            </FieldDescription>
            <FieldError>
              {again.isError
                ? "The request didn't go through. Try again."
                : null}
            </FieldError>
          </Field>
          <Button
            className="h-11 w-full"
            disabled={trimmed === "" || again.isPending}
            type="submit"
          >
            {again.isPending ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : (
              <Smartphone data-icon="inline-start" />
            )}
            Request this iPhone
          </Button>
        </form>
      );
    }
    if (link.data?.status === "local-console") {
      return <RegistrationNotice status="local-console" />;
    }
    if (link.data?.status === "no-secret") {
      return (
        <RegistrationNotice
          secretName={link.data.secretName}
          status="no-secret"
        />
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="ios-device-register-name">
            This iPhone's name
          </FieldLabel>
          <Input
            autoComplete="off"
            className="h-11"
            id="ios-device-register-name"
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            value={typed}
          />
        </Field>
        {link.data?.status === "issued" && signed === typed.trim() ? (
          <a
            className={buttonVariants({
              className: "h-auto min-h-11 w-full whitespace-normal",
            })}
            href={iosDeviceProfileUrl(consolePath(), link.data.token)}
          >
            <Smartphone data-icon="inline-start" />
            Install profile
          </a>
        ) : (
          <Skeleton
            aria-label="Preparing the profile"
            className="h-11 w-full"
          />
        )}
        <p className="text-xs text-muted-foreground">
          Safari only. Allow the download, then install it in Settings, where
          iOS calls it not signed. Safari comes back here, and nothing stays
          installed.
        </p>
      </div>
    );
  })();

  return (
    <Card className="shadow-sm">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Register an iPhone</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 sm:p-6">{body}</CardContent>
    </Card>
  );
}

/**
 * The iOS device registry inside Native builds: the iPhones and iPads a team
 * asked to install ad hoc builds on. Testers register from an iPhone,
 * approvers approve, rename, and remove, and the next ad hoc build registers
 * what was approved with Apple. Android builds need none of this.
 */
export function IosDevicesPage({
  search,
  onSearchChange,
}: {
  readonly search: IosDevicesSearch;
  readonly onSearchChange: (search: IosDevicesSearch) => void;
}) {
  const isMobile = useIsMobile();
  const query = useIosDevicesQuery(search.status);
  const view = query.data;
  const rows = view?.devices;
  const queryClient = useQueryClient();
  // Refresh and Retry read every registry query the page shows: the list,
  // and this iPhone's own row on a phone. A disabled read, such as the row
  // on a computer, stays unread.
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: iosDeviceKeys.all });
  const [dialog, setDialog] = useState<DialogTarget>(null);
  const phone = useIosDevice();
  // The row of the iPhone this page is open on, tagged where its actions are.
  const thisUdid =
    phone?.ios === true ? (phone.udid?.toLowerCase() ?? null) : null;
  const close = () => setDialog(null);

  const empty = (
    <DataTableEmpty
      icon={Smartphone}
      title={
        search.status === undefined
          ? "No iPhones yet"
          : `No ${STATUS_LABELS[search.status].toLowerCase()} iPhones`
      }
    >
      {search.status === undefined ? (
        <p>Open this page on an iPhone to register it.</p>
      ) : (
        <Button
          className="h-11 sm:h-8"
          onClick={() => onSearchChange({})}
          size="sm"
          variant="outline"
        >
          Show all
        </Button>
      )}
    </DataTableEmpty>
  );

  return (
    <div className="flex h-svh min-h-0 min-w-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-3 sm:min-h-12 sm:flex-nowrap sm:bg-card/70 sm:px-4 sm:backdrop-blur-sm">
        <SidebarTrigger className="-ml-1 size-11 lg:size-7" />
        <div className="flex items-center gap-1.5">
          <HardDrive
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <h1 className="text-sm font-medium">Native builds</h1>
        </div>
        <p className="basis-full pl-12 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
          The iPhones and iPads ad hoc builds install on. Android needs none.
        </p>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-muted/5 p-3 sm:p-6">
        <NativeBuildsNav current="devices" />
        <RegisterCard phone={phone} view={view} />
        {view !== undefined && !view.viewer.approversConfigured ? (
          <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
            <p>Nobody approves in this Console. Approve from a terminal:</p>
            <CopyableText
              label="the approve command"
              value={IOS_DEVICES_ADD_COMMAND}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Select
            items={[
              { label: "All statuses", value: ALL },
              ...(Object.keys(STATUS_LABELS) as IosDeviceStatus[]).map(
                (status) => ({ label: STATUS_LABELS[status], value: status }),
              ),
            ]}
            onValueChange={(value) =>
              onSearchChange(
                value === null || value === ALL
                  ? {}
                  : { status: value as IosDeviceStatus },
              )
            }
            value={search.status ?? ALL}
          >
            <SelectTrigger
              aria-label="Status"
              className="min-w-0 flex-1 text-xs data-[size=default]:h-11 sm:w-44 sm:flex-none sm:data-[size=default]:h-8"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {(Object.keys(STATUS_LABELS) as IosDeviceStatus[]).map(
                  (status) => (
                    <SelectItem key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </SelectItem>
                  ),
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            aria-label="Refresh iOS devices"
            className="ml-auto size-11 sm:size-7"
            disabled={query.isFetching}
            onClick={refresh}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
        {query.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>iOS devices couldn't be loaded</AlertTitle>
            <AlertDescription>
              Check your connection and try again.
            </AlertDescription>
            <AlertAction>
              <Button onClick={refresh} size="xs" variant="outline">
                <RefreshCw data-icon="inline-start" />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          // The page scrolls as a whole, the Register card above the list.
          <DataTableFrame className="flex-none">
            {isMobile ? (
              <div
                aria-busy={query.isPlaceholderData}
                aria-label="iOS devices"
                className="aria-busy:opacity-60"
                role="list"
              >
                {query.isLoading ? (
                  <DataCardSkeletons label="Loading iOS devices" />
                ) : rows?.length === 0 ? (
                  <DataCardsEmpty>{empty}</DataCardsEmpty>
                ) : (
                  rows?.map((device) => (
                    <div
                      className="border-b last:border-b-0"
                      key={device.id}
                      role="listitem"
                    >
                      <DeviceCard
                        device={device}
                        isThisIphone={device.udid === thisUdid}
                        onOpen={setDialog}
                        viewer={view!.viewer}
                      />
                    </div>
                  ))
                )}
              </div>
            ) : (
              <DataTable
                aria-busy={query.isPlaceholderData}
                aria-label="iOS devices"
                className="aria-busy:opacity-60"
                header={
                  <>
                    <TableHead>Name</TableHead>
                    <TableHead>UDID</TableHead>
                    <TableHead>Requested by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>Build</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </>
                }
              >
                {query.isLoading ? (
                  <DataTableSkeletonRows
                    columns={COLUMNS + 1}
                    label="Loading iOS devices"
                  />
                ) : rows?.length === 0 ? (
                  <DataTableFullRow columns={COLUMNS + 1}>
                    {empty}
                  </DataTableFullRow>
                ) : (
                  rows?.map((device) => (
                    <DeviceRow
                      device={device}
                      isThisIphone={device.udid === thisUdid}
                      key={device.id}
                      onOpen={setDialog}
                      viewer={view!.viewer}
                    />
                  ))
                )}
              </DataTable>
            )}
          </DataTableFrame>
        )}
      </div>
      {dialog !== null && dialog.kind !== "remove" ? (
        <NameDialog key={dialog.device.id} onClose={close} target={dialog} />
      ) : null}
      {dialog?.kind === "remove" && view !== undefined ? (
        <RemoveDialog
          device={dialog.device}
          key={dialog.device.id}
          onClose={close}
          viewer={view.viewer}
        />
      ) : null}
    </div>
  );
}

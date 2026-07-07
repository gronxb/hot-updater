import type { Bundle } from "@hot-updater/plugin-core";
import type { LucideIcon } from "lucide-react";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DeleteItemStatus = "queued" | "deleting" | "deleted" | "failed";

export interface DeleteItem {
  readonly bundle: Bundle;
  readonly status: DeleteItemStatus;
  readonly message?: string;
}

interface SelectedBundlesDeleteProgressTableProps {
  readonly items: readonly DeleteItem[];
}

const statusLabels = {
  queued: "Queued",
  deleting: "Deleting",
  deleted: "Deleted",
  failed: "Failed",
} as const satisfies Record<DeleteItemStatus, string>;

const getStatusIcon = (
  status: Exclude<DeleteItemStatus, "queued">,
): {
  readonly className: string;
  readonly Icon: LucideIcon;
} => {
  switch (status) {
    case "failed":
      return { className: "size-3.5 text-destructive", Icon: XCircle };
    case "deleting":
      return {
        className: "size-3.5 animate-spin text-primary",
        Icon: LoaderCircle,
      };
    case "deleted":
      return { className: "size-3.5 text-primary", Icon: CheckCircle2 };
  }
};

function DeleteStatusIcon({ status }: { readonly status: DeleteItemStatus }) {
  if (status === "queued") {
    return null;
  }

  const label = statusLabels[status];
  const { className, Icon } = getStatusIcon(status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={label} role="img">
          <Icon className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SelectedBundlesDeleteProgressTable({
  items,
}: SelectedBundlesDeleteProgressTableProps) {
  return (
    <Card>
      <CardContent className="max-h-[50vh] overflow-y-auto p-0">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead className="w-12 text-center">Status</TableHead>
              <TableHead>Bundle</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.bundle.id}>
                <TableCell className="text-center align-middle">
                  <div className="flex justify-center">
                    <DeleteStatusIcon status={item.status} />
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="min-w-0">
                    <div className="break-all font-mono text-[11px] text-foreground">
                      {item.bundle.id}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{item.bundle.channel}</span>
                      <span>{item.bundle.platform}</span>
                      {item.message ? (
                        <span className="text-destructive">
                          {item.message}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

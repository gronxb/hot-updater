import { formatDateTimeFromBundleVersion } from "@/utils/formatDate.js";
import type { UpdateSource } from "@hot-updater/core";
import { Text } from "ink";
import { Table } from "./Table.js";

export const BundleInfoTable = ({
  source,
  renders,
  widths,
}: {
  source: UpdateSource;
  renders?: {
    active?: () => React.ReactNode;
    createdAt?: () => React.ReactNode;
    platform?: () => React.ReactNode;
    description?: () => React.ReactNode;
    forceUpdate?: () => React.ReactNode;
  };
  widths?: {
    active?: number;
    createdAt?: number;
    platform?: number;
    description?: number;
    forceUpdate?: number;
  };
}) => {
  return (
    <Table
      data={[
        {
          createdAt: renders?.createdAt?.() ?? (
            <Text>
              {formatDateTimeFromBundleVersion(String(source.bundleVersion))}
            </Text>
          ),
          platform: renders?.platform?.() ?? <Text>{source.platform}</Text>,
          description: renders?.description?.() ?? (
            <Text>{source.description || "-"}</Text>
          ),
          forceUpdate: renders?.forceUpdate?.() ?? (
            <Text>{source.forceUpdate ? "O" : "X"}</Text>
          ),
          active:
            renders?.active?.() ??
            (source.enabled ? (
              <Text color="green">ACTIVE</Text>
            ) : (
              <Text color="red">INACTIVE</Text>
            )),
        },
      ]}
      widths={{
        createdAt: 25,
        platform: 15,
        description: (source.description?.length ?? 0) + 15,
        forceUpdate: 15,
        active: 15,
        ...widths,
      }}
      headers={{
        createdAt: <Text color="blue">createdAt</Text>,
        platform: <Text color="blue">platform</Text>,
        description: <Text color="blue">description</Text>,
        forceUpdate: <Text color="blue">forceUpdate</Text>,
        active: <Text color="blue">active</Text>,
      }}
    />
  );
};

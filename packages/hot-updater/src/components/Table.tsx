import { Box, Text } from "ink";
import React, { useMemo } from "react";

type ScalarDict = {
  [key: string]: React.ReactNode;
};

export type Column = {
  key: string;
  width: number;
};

export interface TableProps {
  data: ScalarDict[];
  headers?: ScalarDict;
  widths: {
    [key: string]: number;
  };
}

export const Table = ({ data, headers, widths }: TableProps) => {
  const columns = useMemo(
    () =>
      Object.entries(widths).map(([key, width]) => ({
        key,
        width,
      })),
    [widths],
  );

  return (
    <Box flexDirection="column">
      {renderHeaderSeparators(columns)}

      {headers && (
        <>
          {renderRow(headers, columns)}
          {renderRowSeparators(columns)}
        </>
      )}

      {data.map((row, index) => (
        <React.Fragment key={`row-${index}`}>
          {index !== 0 && renderRowSeparators(columns)}
          {renderRow(row, columns)}
        </React.Fragment>
      ))}
      {renderFooterSeparators(columns)}
    </Box>
  );
};

// Helper function to render a row with separators
function renderRow(row: ScalarDict, columns: Column[]) {
  return (
    <Box flexDirection="row">
      <Text>│</Text>
      {columns.map((column, index) => (
        <React.Fragment key={column.key}>
          {index !== 0 && <Text>│</Text>}
          {/* Add separator before each cell except the first one */}
          <Box width={column.width} justifyContent="center">
            {row[column.key]}
          </Box>
        </React.Fragment>
      ))}
      <Text>│</Text>
    </Box>
  );
}

function renderHeaderSeparators(columns: Column[]) {
  return renderRowSeparators(columns, "┌", "┬", "┐");
}

function renderFooterSeparators(columns: Column[]) {
  return renderRowSeparators(columns, "└", "┴", "┘");
}

function renderRowSeparators(
  columns: Column[],
  leftChar = "├",
  midChar = "┼",
  rightChar = "┤",
) {
  return (
    <Box flexDirection="row">
      <Text>{leftChar}</Text>
      {columns.map((column, index) => (
        <React.Fragment key={column.key}>
          <Text>{"─".repeat(column.width)}</Text>
          {index < columns.length - 1 ? (
            <Text>{midChar}</Text>
          ) : (
            <Text>{rightChar}</Text>
          )}
        </React.Fragment>
      ))}
    </Box>
  );
}

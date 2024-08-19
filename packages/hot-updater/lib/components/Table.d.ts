import React from "react";
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
export declare const Table: ({ data, headers, widths }: TableProps) => import("react/jsx-runtime").JSX.Element;
export {};

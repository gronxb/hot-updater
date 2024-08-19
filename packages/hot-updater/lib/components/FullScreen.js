import { jsx as _jsx } from "react/jsx-runtime";
import { Box } from "ink";
import { useEffect, useState } from "react";
export const FullScreen = (props) => {
    const [size, setSize] = useState({
        columns: process.stdout.columns,
        rows: process.stdout.rows,
    });
    useEffect(() => {
        function onResize() {
            setSize({
                columns: process.stdout.columns,
                rows: process.stdout.rows,
            });
        }
        process.stdout.on("resize", onResize);
        process.stdout.write("\x1b[?1049h");
        return () => {
            process.stdout.off("resize", onResize);
            process.stdout.write("\x1b[?1049l");
        };
    }, []);
    return (_jsx(Box, { width: size.columns, height: size.rows, flexDirection: "column", children: props.children }));
};

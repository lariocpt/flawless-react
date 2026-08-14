import type * as React from "react";

/**
 * A compound part whose root tag HTML only permits inside a <table>. Mounted
 * into a bare div, React 19 logs "In HTML, <tbody> cannot be a child of <div>",
 * and the spec then fails the component for a warning the harness caused.
 */
export const TableBody: React.FC<React.ComponentProps<"tbody">> = (props) => <tbody {...props} />;

export const TableRow: React.FC<React.ComponentProps<"tr">> = (props) => <tr {...props} />;

export default TableBody;

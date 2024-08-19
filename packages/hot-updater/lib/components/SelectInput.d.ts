import { type FC } from "react";
export interface SelectInputProps<V> {
    /**
     * Items to display in a list. Each item must be an object and have `label` and `value` props, it may also optionally have a `key` prop.
     * If no `key` prop is provided, `value` will be used as the item key.
     */
    readonly items?: Array<Item<V>>;
    /**
     * Listen to user's input. Useful in case there are multiple input components at the same time and input must be "routed" to a specific component.
     *
     * @default true
     */
    readonly isFocused?: boolean;
    /**
     * Index of initially-selected item in `items` array.
     *
     * @default 0
     */
    readonly initialIndex?: number;
    /**
     * Number of items to display.
     */
    readonly limit?: number;
    readonly indicatorComponent: FC<IndicatorComponentProps>;
    /**
     * Custom component to override the default item component.
     */
    readonly itemComponent?: FC<ItemComponentProps>;
    /**
     * Function to call when user selects an item. Item object is passed to that function as an argument.
     */
    readonly onSelect?: (item: Item<V>) => void;
    /**
     * Function to call when user highlights an item. Item object is passed to that function as an argument.
     */
    readonly onHighlight?: (item: Item<V>) => void;
}
export type Item<V> = {
    key?: string;
    label: string;
    value: V;
};
export interface ItemComponentProps {
    readonly isSelected?: boolean;
    readonly label: string;
}
export interface IndicatorComponentProps {
    readonly isSelected?: boolean;
}
export declare function SelectInput<V>({ items, isFocused, initialIndex, indicatorComponent, itemComponent, limit: customLimit, onSelect, onHighlight, }: SelectInputProps<V>): import("react/jsx-runtime").JSX.Element;

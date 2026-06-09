import React from "react";

import type { ScreenProps } from "../screens/types";
import type { ScreenName } from "../types";

export type ModelScreenName = Exclude<ScreenName, "Ready">;
type ModelScreenComponent = React.ComponentType<ScreenProps>;

export type ModelScreen = {
  readonly name: ModelScreenName;
  readonly render: (model: ScreenProps["model"]) => React.JSX.Element;
};

export const defineModelScreens = (
  entries: readonly (readonly [ModelScreenName, ModelScreenComponent])[],
): readonly ModelScreen[] =>
  entries.map(([name, Component]) => ({
    name,
    render: (model) => <Component model={model} />,
  }));

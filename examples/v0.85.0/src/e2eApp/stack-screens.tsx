import { assertionModelScreens } from "./stackScreens/assertion-stack-screens";
import { interactionModelScreens } from "./stackScreens/interaction-stack-screens";

export const modelScreens = [
  ...assertionModelScreens,
  ...interactionModelScreens,
];

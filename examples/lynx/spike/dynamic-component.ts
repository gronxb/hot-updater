declare const __SPIKE_VARIANT__: string;
declare const __JS__: boolean;

export const dynamicVariant = __SPIKE_VARIANT__;

// This app-owned component tests the native template loader and background
// evaluation. It does not mount a React/Vue/Octane UI component.
if (__JS__) {
  lynx.setSharedData("hotUpdaterG1Dynamic", dynamicVariant);
  console.log("HOT_UPDATER_G1_DYNAMIC_EXECUTED", dynamicVariant);
}

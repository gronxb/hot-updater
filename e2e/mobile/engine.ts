import { defineEngine } from "e2e/engine";
import type { Engine, EngineHandle } from "e2e/engine";

export const RAW_TEXT_ATTRIBUTE = "hot-updater-raw-text";

// The SDK normalizes textContent/toHaveText. OTA result strings must retain
// their original whitespace, so expose the mobile node's text as an attribute.
export function scenarioEngine(engine: EngineHandle): EngineHandle {
  const manifest = Object.fromEntries(
    Object.entries(engine).filter(([key]) => key !== "capabilities"),
  ) as Engine;
  const locate = engine.locate;
  if (!locate) throw new Error("The mobile engine must support locators");
  return defineEngine({
    ...manifest,
    fixtures: {
      ...engine.fixtures,
      hotUpdaterAttemptSignal: (context) =>
        context.fixture(
          "hotUpdaterAttemptSignal",
          { signal: context.signal },
          {},
        ),
    },
    locate: async (expression, context) =>
      (await locate(expression, context)).map((node) => ({
        ...node,
        attributes: {
          ...node.attributes,
          [RAW_TEXT_ATTRIBUTE]: node.text ?? node.value ?? "",
        },
      })),
  });
}

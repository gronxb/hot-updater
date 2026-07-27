import { contentConformanceAssertions } from "./contentConformanceAssertions";
import { lifecycleConformanceAssertions } from "./lifecycleConformanceAssertions";
import { stressConformanceAssertions } from "./stressConformanceAssertions";

export {
  createPacedStorageStream,
  readStorageStream,
  StorageConformanceError,
  type StorageConformanceAssertionName,
  type PacedStreamMetrics,
  type StreamVerification,
  verifyStorageChunkSequence,
} from "./conformanceSupport";
export {
  createLifecycleObservableHarness,
  type LifecycleHarness,
  type LifecycleSnapshot,
} from "./lifecycleObservableAdapter";

export const storageConformanceAssertions = {
  ...contentConformanceAssertions,
  ...lifecycleConformanceAssertions,
  ...stressConformanceAssertions,
} as const;

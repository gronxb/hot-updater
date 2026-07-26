import { contentConformanceAssertions } from "./contentConformanceAssertions";
import { lifecycleConformanceAssertions } from "./lifecycleConformanceAssertions";

export {
  readStorageStream,
  StorageConformanceError,
  type StorageConformanceAssertionName,
} from "./conformanceSupport";

export const storageConformanceAssertions = {
  ...contentConformanceAssertions,
  ...lifecycleConformanceAssertions,
} as const;

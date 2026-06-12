import { BundleUnitOfWork } from "./bundleUnitOfWork";

const requestUnitOfWorks = new WeakMap<object, BundleUnitOfWork>();

export const isUnitOfWorkContext = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

export const getRequestBundleUnitOfWork = (
  context: unknown,
): BundleUnitOfWork | null => {
  if (!isUnitOfWorkContext(context)) {
    return null;
  }

  let unitOfWork = requestUnitOfWorks.get(context);
  if (!unitOfWork) {
    unitOfWork = new BundleUnitOfWork();
    requestUnitOfWorks.set(context, unitOfWork);
  }
  return unitOfWork;
};

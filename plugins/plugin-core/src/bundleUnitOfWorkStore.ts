import type { BundleUnitOfWork } from "./bundleUnitOfWork";
import { DatabaseUnitOfWork } from "./databaseUnitOfWork";

const requestUnitOfWorks = new WeakMap<object, DatabaseUnitOfWork>();

export const isUnitOfWorkContext = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

export const getRequestDatabaseUnitOfWork = (
  context: unknown,
): DatabaseUnitOfWork | null => {
  if (!isUnitOfWorkContext(context)) {
    return null;
  }

  let unitOfWork = requestUnitOfWorks.get(context);
  if (!unitOfWork) {
    unitOfWork = new DatabaseUnitOfWork();
    requestUnitOfWorks.set(context, unitOfWork);
  }
  return unitOfWork;
};

export const getRequestBundleUnitOfWork = (
  context: unknown,
): BundleUnitOfWork | null =>
  getRequestDatabaseUnitOfWork(context)?.bundles ?? null;

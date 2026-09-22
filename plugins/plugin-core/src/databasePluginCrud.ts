import {
  DatabasePluginInputError,
  selectRow,
  validateBundleUpdateData,
  validateApiKeyUpdateData,
  validateReleaseCatalogUpdateData,
  validateReleaseTargetUpdate,
  validateReleaseUpdateData,
  validateCreateData,
  validateModel,
  validateMutationWhere,
  validateResult,
  validateSelect,
  validateUpdateWhere,
  validateWhere,
} from "./databasePluginCrudValidation";
import { createDatabasePluginReads } from "./databasePluginReads";
import type {
  CreateDatabaseImplementationInput,
  DatabasePluginCrud as DatabasePluginCrudContract,
  DeleteDatabaseImplementationInput,
  SelectedDatabaseInputRow,
  TransactionDatabasePluginImplementation,
  UpdateDatabaseImplementationInput,
} from "./types/internal";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrudValidation";

export type DatabasePluginCrud = DatabasePluginCrudContract;

export const createDatabasePluginCrud = (
  implementation: TransactionDatabasePluginImplementation,
): DatabasePluginCrud => {
  async function create<TInput extends CreateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput>> {
    validateModel(input.model);
    validateCreateData(input.model, input.data);
    if (
      input.onConflict !== undefined &&
      !(
        input.onConflict === "ignore" &&
        (input.model === "channels" || input.model === "api_keys")
      )
    ) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateSelect(input.model, input.select);
    const row = await implementation.create(input);
    validateResult(input.model, row, input.select);
    return selectRow(row, input);
  }

  async function update<TInput extends UpdateDatabaseImplementationInput>(
    input: TInput,
  ): Promise<SelectedDatabaseInputRow<TInput> | null> {
    validateModel(input.model);
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    validateUpdateWhere(input.model, input.where);
    if (input.model === "bundles") {
      validateBundleUpdateData(input.update);
    } else if (input.model === "releases") {
      validateReleaseUpdateData(input.update);
    } else if (input.model === "release_catalogs") {
      validateReleaseCatalogUpdateData(input.update);
    } else if (input.model === "api_keys") {
      validateApiKeyUpdateData(input.update);
    } else {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateSelect(input.model, input.select);
    if (input.model === "bundles") {
    } else if (input.model === "releases") {
      await validateReleaseTargetUpdate(implementation, input);
    }
    const row = await implementation.update(input);
    if (row === null) return null;
    validateResult(input.model, row, input.select);
    return selectRow(row, input);
  }

  async function deleteRows(
    input: DeleteDatabaseImplementationInput,
  ): Promise<void> {
    validateModel(input.model);
    if (
      input.model !== "bundles" &&
      input.model !== "bundle_patches" &&
      input.model !== "releases" &&
      input.model !== "channels"
    ) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    validateWhere(input.model, input.where);
    validateMutationWhere(input.where);
    await implementation.delete(input);
  }

  return {
    create,
    update,
    delete: deleteRows,
    ...createDatabasePluginReads(implementation),
  };
};

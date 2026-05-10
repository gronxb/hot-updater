export const formatSupabaseStorageError = (error: unknown) => {
  if (!error) {
    return "unknown error";
  }

  if (typeof error !== "object") {
    return String(error);
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    return message;
  }

  if (message !== undefined) {
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const isSupabaseStorageObjectNotFoundError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const storageError = error as {
    __isStorageError?: unknown;
    message?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };

  if (String(storageError.statusCode) === "404") {
    return true;
  }

  const message = formatSupabaseStorageError(storageError).toLowerCase();
  if (
    message === "{}" &&
    (storageError.__isStorageError === true ||
      storageError.name === "StorageApiError")
  ) {
    return true;
  }

  return message.includes("object not found") || message.includes("not found");
};

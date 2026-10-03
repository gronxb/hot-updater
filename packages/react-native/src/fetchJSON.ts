import { fetchUpdateResponse, type UpdateRequest } from "./fetchUpdateResponse";
import { UpdateHttpError } from "./updateError";

export class FetchJSONResponseError extends UpdateHttpError {}

export const fetchJSON = async <T>(
  input: Omit<UpdateRequest, "resource">,
): Promise<T> => {
  const { response, body } = await fetchUpdateResponse({
    ...input,
    resource: "artifact",
  });
  if (response.status !== 200) {
    throw new FetchJSONResponseError(
      response.status,
      response.statusText,
      body ?? undefined,
    );
  }
  return JSON.parse(body!) as T;
};

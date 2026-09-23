import { hotUpdater } from "./fixture.mjs";

export default {
  fetch: (request) => hotUpdater.handlers.client(request),
};

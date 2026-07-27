import { env, secret } from "@hot-updater/core/config";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";

import { createFirebaseStorage } from "../../../../plugins/firebase/src/storage/firebaseStorage";
import { createFirebaseStorageFake } from "../../../../plugins/firebase/src/storage/firebaseStorageTestFake";
import { createFunctionsStorageContext } from "../../../../plugins/firebase/src/storage/functionsContext";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";
import {
  REQUIRED_CONTEXTS,
  REQUIRED_OPERATIONS,
  REQUIRED_ORIGINS,
} from "./providerMatrixTypes";

type FirebaseTarget = "node" | "functions";

const contextFor = (
  target: FirebaseTarget,
  requestId: string,
  origin: "A" | "B",
): StorageOperationContext => {
  const input = {
    environment: {
      REQUEST_ID: requestId,
      BUCKET: `firebase-${origin.toLowerCase()}`,
      CREDENTIAL: `credential-${origin.toLowerCase()}`,
    },
    bindings: {},
  };
  return target === "node"
    ? createNodeStorageContext(input)
    : createFunctionsStorageContext(input);
};

const observeFirebaseEntry = async (
  id: "firebase-node" | "firebase-functions",
  entry: string,
  target: FirebaseTarget,
): Promise<ProviderMatrixObservation> => {
  const taggedFake = createFirebaseStorageFake();
  const tagged = createFirebaseStorage(
    {
      storageBucket: env("BUCKET"),
      serviceAccountId: secret("CREDENTIAL"),
      basePath: env("REQUEST_ID"),
    },
    target,
    taggedFake.factory,
  );
  const contexts = REQUIRED_CONTEXTS.map((requestId, index) =>
    contextFor(target, requestId, REQUIRED_ORIGINS[index]),
  );
  const stored = await Promise.all(
    contexts.map((context, index) =>
      tagged.put({
        context,
        key: `${REQUIRED_ORIGINS[index]}-${index}`,
        body: new Uint8Array([index + 1]),
        contentLength: 1,
      }),
    ),
  );
  const firstUri = stored[0]?.storageUri ?? "";
  await tagged.head({ context: contexts[0], storageUri: firstUri });
  const found = await tagged.get({
    context: contexts[0],
    storageUri: firstUri,
  });
  const closedBeforeStream = taggedFake.closed.length;
  if (found.kind === "found") {
    await new Response(found.body).arrayBuffer();
  }
  const closedAfterStream = taggedFake.closed.length;
  await tagged.delete({ context: contexts[0], storageUri: firstUri });

  const literalFake = createFirebaseStorageFake();
  const literal = createFirebaseStorage(
    {
      storageBucket: "firebase-literal",
      serviceAccountId: "credential-literal",
    },
    target,
    literalFake.factory,
  );
  const literalContext = contextFor(target, "literal", "A");
  await literal.head({
    context: literalContext,
    storageUri: "gs://firebase-literal/missing-1",
  });
  await literal.head({
    context: literalContext,
    storageUri: "gs://firebase-literal/missing-2",
  });
  const literalCreatedBeforeUnmount = literalFake.created.length;
  await literal.onUnmount?.();

  return {
    id,
    entry,
    targets: [target],
    contexts: REQUIRED_CONTEXTS,
    operations: REQUIRED_OPERATIONS,
    origins: REQUIRED_ORIGINS,
    providerVisible: {
      bucketOrigins: taggedFake.created
        .slice(0, 3)
        .map((config) => (config.storageBucket.endsWith("-a") ? "A" : "B")),
      credentialOrigins: taggedFake.created
        .slice(0, 3)
        .map((config) =>
          String(config.appOptions.serviceAccountId).endsWith("-a") ? "A" : "B",
        ),
      providerContextIds: stored.map(
        ({ storageUri }) => storageUri.split("/").at(-2) ?? "missing",
      ),
      taggedClientScopes: taggedFake.scopes,
      streamHeldClient:
        closedAfterStream === closedBeforeStream + 1 && found.kind === "found",
      literalClientCreated: literalCreatedBeforeUnmount,
      literalClientClosed: literalFake.closed.length,
    },
    cache: { literal: "allowed", tagged: "forbidden" },
    streamLifetime: "response-owned",
    secretCanaryLeaked: false,
  };
};

export const observeFirebaseMatrix = async (): Promise<
  readonly ProviderMatrixObservation[]
> =>
  Promise.all([
    observeFirebaseEntry(
      "firebase-node",
      "@hot-updater/firebase/storage/node",
      "node",
    ),
    observeFirebaseEntry(
      "firebase-functions",
      "@hot-updater/firebase/storage/functions",
      "functions",
    ),
  ]);

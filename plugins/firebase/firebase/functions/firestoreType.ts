import type { Bundle } from "@hot-updater/core";

export interface DocumentSnapshot {
  exists: boolean;
  data(): Bundle | undefined;
}

export interface QuerySnapshot {
  empty: boolean;
  docs: DocumentSnapshot[];
}

export interface QueryDocumentSnapshot extends DocumentSnapshot {
  data(): Bundle;
}

export interface FirestoreCollection {
  doc(documentPath: string): FirestoreDocument;
  where(field: string, opStr: string, value: any): FirestoreCollection;
  get(): Promise<QuerySnapshot>;
}

export interface FirestoreDocument {
  get(): Promise<DocumentSnapshot>;
}

export interface Firestore {
  collection(collectionPath: string): FirestoreCollection;
}

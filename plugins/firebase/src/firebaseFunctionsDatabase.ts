import type { AppOptions } from "firebase-admin/app";
import { firebaseDatabase } from "./firebaseDatabase";

export type FirebaseFunctionsDatabaseConfig = AppOptions;

export const firebaseFunctionsDatabase = firebaseDatabase;

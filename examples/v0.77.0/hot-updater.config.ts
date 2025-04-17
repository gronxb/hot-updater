import { metro } from '@hot-updater/metro';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import admin from "firebase-admin/app";
import { defineConfig } from 'hot-updater';
import 'dotenv/config';

// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Internally, Firebase Admin SDK calls initializeApp which requires authentication credentials.
// You must provide appropriate credentials for your environment.
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path.
// Example: GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json
const credential = admin.applicationDefault();

export default defineConfig({
  build: metro({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
});
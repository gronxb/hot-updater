import {metro} from '@hot-updater/metro';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import {defineConfig} from 'hot-updater';
import 'dotenv/config';
export default defineConfig({
  build: metro({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
    clientEmail:process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
    clientEmail:process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
  }),
});
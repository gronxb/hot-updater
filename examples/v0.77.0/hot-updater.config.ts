import {metro} from '@hot-updater/metro';
import {supabaseDatabase} from '@hot-updater/supabase';
import {firebaseStorage} from '@hot-updater/firebase';
import {defineConfig} from 'hot-updater';
import 'dotenv/config';

export default defineConfig({
  build: metro({enableHermes: true}),
  storage: firebaseStorage({
    firebaseConfig: {
      apiKey: process.env.HOT_UPDATER_FIREBASE_API_KEY,
      authDomain: process.env.HOT_UPDATER_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
      storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.HOT_UPDATER_FIREBASE_MESSAGING_SENDERID,
      appId: process.env.HOT_UPDATER_FIREBASE_APP_ID,
    },
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
});

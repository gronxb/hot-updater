// Example: Mixed providers (Firestore + Supabase Storage)
import { HotUpdater } from '@hot-updater/plugin-core';
import { firestoreDatabase, supabaseStorage } from '@hot-updater/adapters';

// This combination works because Firestore has no dependencies constraint
export const hotUpdater = new HotUpdater({
  database: firestoreDatabase({
    // firestore: firestoreInstance
  }),
  storage: supabaseStorage({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  })
});

// Warning will be logged:
// "Adapter compatibility warnings: Using mixed providers (firestore + supabase-storage). 
//  While supported, consider using matching providers for optimal performance."

// === Example of incompatible combination ===

// This would throw an error:
// const incompatibleConfig = new HotUpdater({
//   database: d1Database({ database: db }),        // dependencies: ['r2', 'cloudfront']
//   storage: supabaseStorage({ /* config */ })     // name: 'supabase-storage' ❌
// });
// 
// Error: "Adapter compatibility error: Database adapter 'd1' is not compatible with 
//         storage adapter 'supabase-storage'. Compatible storage adapters: r2, cloudfront"

// === Example of optimal combinations ===

// 1. Supabase + Supabase Storage
const supabaseOptimal = new HotUpdater({
  database: supabaseDatabase({ /* config */ }),
  storage: supabaseStorage({ /* config */ })
});

// 2. Cloudflare D1 + R2
const cloudflareOptimal = new HotUpdater({
  database: d1Database({ /* config */ }),
  storage: r2Storage({ /* config */ })
});

// 3. Firebase combination
const firebaseOptimal = new HotUpdater({
  database: firestoreDatabase({ /* config */ }),
  storage: firebaseStorage({ /* config */ })
});

// 4. AWS combination
const awsOptimal = new HotUpdater({
  database: cloudfrontDatabase({ /* config */ }),
  storage: cloudfrontStorage({ /* config */ })
});
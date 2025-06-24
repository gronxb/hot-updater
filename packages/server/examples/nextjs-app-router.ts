// Next.js App Router example using @hot-updater/server
// app/api/check-update/[...route]/route.ts

import { HotUpdater, supabaseDatabase, supabaseStorage } from '@hot-updater/server';

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  }),
  storage: supabaseStorage({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  })
});

export async function GET(request: Request) {
  return hotUpdater.handler(request);
}

export async function POST(request: Request) {
  return hotUpdater.handler(request);
}
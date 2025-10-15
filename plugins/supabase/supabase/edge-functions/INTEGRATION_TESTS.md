# Supabase Edge Functions Integration Tests

## Overview

These integration tests validate the hot-updater Supabase Edge Functions by making actual HTTP requests to a local Supabase instance and verifying responses against a live PostgreSQL database.

## Prerequisites

1. Install Supabase CLI:
   ```bash
   npm install -g supabase
   ```

2. Docker must be running (required for Supabase local development)

## Running Integration Tests

### Start Supabase Local

In one terminal, start the local Supabase instance:

```bash
cd plugins/supabase/supabase
supabase start
```

This will start:
- PostgreSQL Database on `localhost:54322`
- Edge Functions Runtime on `localhost:54321`
- Studio UI on `localhost:54323`

The command will output the service role key and anon key. If different from defaults, export them:

```bash
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
export SUPABASE_ANON_KEY="your-anon-key"
```

### Apply Database Migrations

Ensure the database schema is up to date:

```bash
cd plugins/supabase/supabase
supabase db reset
```

### Serve Edge Functions

In another terminal, serve the edge functions:

```bash
cd plugins/supabase/supabase
supabase functions serve hot-updater --no-verify-jwt
```

### Run the Tests

In a third terminal, run the integration tests:

```bash
pnpm test plugins/supabase/supabase/edge-functions/integration.spec.ts
```

## Configuration

The integration tests use the following default configuration:
- **Supabase URL**: `http://127.0.0.1:54321`
- **Function Name**: `hot-updater`
- **Default Keys**: Supabase local development keys

These can be overridden via environment variables if needed.

## How It Works

1. **Setup**: Tests insert bundle data into the PostgreSQL database via Supabase client
2. **Execution**: Tests make HTTP requests to the Edge Function endpoint
3. **Verification**: Tests verify the response matches expected update logic
4. **Cleanup**: Tests delete all bundles from the database after each test

This approach ensures tests validate the entire request/response cycle including:
- HTTP header parsing
- PostgreSQL stored procedure execution
- Response formatting with signed URLs
- Error handling

## Troubleshooting

### "Database tables may not be initialized"

Run migrations:
```bash
cd plugins/supabase/supabase
supabase db reset
```

### "Connection refused"

Ensure Supabase is running:
```bash
cd plugins/supabase/supabase
supabase status
```

### Edge Function not found

Ensure the function is being served:
```bash
cd plugins/supabase/supabase
supabase functions serve hot-updater --no-verify-jwt
```

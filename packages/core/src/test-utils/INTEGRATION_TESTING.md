# Integration Testing Guide

This guide explains how to use the HTTP-based integration test framework for testing hot-updater provider plugins against real serverless environments.

## Overview

The integration test framework (`setupGetUpdateInfoIntegrationTestSuite`) allows plugin developers to run comprehensive tests against actual server deployments via HTTP fetch requests. Unlike unit tests that mock internal functions, integration tests validate the entire request/response cycle including:

- HTTP request handling
- Database queries
- Business logic
- Response serialization
- Error handling

## Architecture

### Test Components

1. **Integration Test Suite** (`setupGetUpdateInfoIntegrationTestSuite`)
   - Defines 100+ test cases covering both app version and fingerprint strategies
   - Makes actual HTTP POST requests to test endpoints
   - Validates UpdateInfo responses

2. **Integration Test Context** (`IntegrationTestContext`)
   - Configuration object that connects tests to your server
   - Provides database seeding and cleanup functions

3. **Fetch Helper** (`fetchUpdateInfo`)
   - Reusable HTTP client for making update check requests
   - Handles status codes, error responses, and JSON parsing

## Quick Start

### Step 1: Set Up Test Server

First, deploy or start your serverless function locally:

```typescript
// Example: Start local development server
import { startServer } from './my-plugin-server';

let server: Server;
let serverUrl: string;

beforeAll(async () => {
  server = await startServer();
  serverUrl = `http://localhost:${server.port}/api/update`;
});

afterAll(async () => {
  await server.close();
});
```

### Step 2: Implement Database Helpers

Create functions to seed and clear test data:

```typescript
import { Bundle } from '@hot-updater/core';
import { db } from './database';

async function seedBundles(bundles: Bundle[]): Promise<void> {
  for (const bundle of bundles) {
    await db.query(`
      INSERT INTO bundles (
        id, file_hash, platform, target_app_version,
        should_force_update, enabled, git_commit_hash,
        message, channel, storage_uri, fingerprint_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
    `, [
      bundle.id,
      bundle.fileHash,
      bundle.platform,
      bundle.targetAppVersion,
      bundle.shouldForceUpdate,
      bundle.enabled,
      bundle.gitCommitHash,
      bundle.message,
      bundle.channel,
      bundle.storageUri,
      bundle.fingerprintHash
    ]);
  }
}

async function clearBundles(): Promise<void> {
  await db.query('DELETE FROM bundles');
}
```

### Step 3: Set Up Integration Tests

Import and configure the test suite:

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';
import { describe } from 'vitest';

describe('getUpdateInfo integration tests', () => {
  setupGetUpdateInfoIntegrationTestSuite({
    serverUrl: 'http://localhost:3000/api/update',
    seedBundles,
    clearBundles,
    headers: {
      // Optional: Add authentication headers
      'Authorization': 'Bearer test-token',
      'X-Test-Mode': 'true'
    }
  });
});
```

### Step 4: Run Tests

```bash
npm test
# or
pnpm test
```

## Provider-Specific Examples

### AWS Lambda Example

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';
import { beforeAll, afterAll, describe } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:8000' // LocalStack
}));

const TABLE_NAME = 'hot-updater-test-bundles';

describe('AWS Lambda getUpdateInfo integration', () => {
  setupGetUpdateInfoIntegrationTestSuite({
    serverUrl: 'http://localhost:3001/dev/update',

    async seedBundles(bundles) {
      await Promise.all(
        bundles.map(bundle =>
          dynamoClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: bundle
          }))
        )
      );
    },

    async clearBundles() {
      // Scan and delete all items
      const items = await dynamoClient.send(new ScanCommand({
        TableName: TABLE_NAME
      }));

      await Promise.all(
        (items.Items || []).map(item =>
          dynamoClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { id: item.id }
          }))
        )
      );
    }
  });
});
```

### Cloudflare Workers Example

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';
import { env } from 'cloudflare:test';
import { beforeEach, describe } from 'vitest';

describe('Cloudflare Workers getUpdateInfo integration', () => {
  setupGetUpdateInfoIntegrationTestSuite({
    serverUrl: 'http://localhost:8787/update',

    async seedBundles(bundles) {
      const queries = bundles.map(bundle => `
        INSERT INTO bundles (
          id, file_hash, platform, target_app_version,
          should_force_update, enabled, git_commit_hash,
          message, channel, storage_uri, fingerprint_hash
        ) VALUES (
          '${bundle.id}', '${bundle.fileHash}', '${bundle.platform}',
          ${bundle.targetAppVersion ? `'${bundle.targetAppVersion}'` : 'null'},
          ${bundle.shouldForceUpdate}, ${bundle.enabled},
          ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : 'null'},
          ${bundle.message ? `'${bundle.message}'` : 'null'},
          '${bundle.channel}', '${bundle.storageUri}',
          ${bundle.fingerprintHash ? `'${bundle.fingerprintHash}'` : 'null'}
        )
      `).join(';');

      await env.DB.prepare(queries).run();
    },

    async clearBundles() {
      await env.DB.prepare('DELETE FROM bundles').run();
    }
  });
});
```

### Firebase Functions Example

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';
import { getFirestore } from 'firebase-admin/firestore';
import { describe } from 'vitest';

const db = getFirestore();
const COLLECTION_NAME = 'bundles';

describe('Firebase Functions getUpdateInfo integration', () => {
  setupGetUpdateInfoIntegrationTestSuite({
    serverUrl: 'http://localhost:5001/my-project/us-central1/getUpdateInfo',

    async seedBundles(bundles) {
      const batch = db.batch();

      for (const bundle of bundles) {
        const docRef = db.collection(COLLECTION_NAME).doc(bundle.id);
        batch.set(docRef, bundle);
      }

      await batch.commit();
    },

    async clearBundles() {
      const snapshot = await db.collection(COLLECTION_NAME).get();
      const batch = db.batch();

      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();
    }
  });
});
```

### Supabase Edge Functions Example

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';
import { createClient } from '@supabase/supabase-js';
import { describe } from 'vitest';

const supabase = createClient(
  'http://localhost:54321',
  'test-anon-key'
);

describe('Supabase Edge Functions getUpdateInfo integration', () => {
  setupGetUpdateInfoIntegrationTestSuite({
    serverUrl: 'http://localhost:54321/functions/v1/update',

    async seedBundles(bundles) {
      const { error } = await supabase
        .from('bundles')
        .insert(bundles);

      if (error) throw error;
    },

    async clearBundles() {
      const { error } = await supabase
        .from('bundles')
        .delete()
        .neq('id', ''); // Delete all rows

      if (error) throw error;
    },

    headers: {
      'Authorization': `Bearer test-anon-key`
    }
  });
});
```

## API Reference

### IntegrationTestContext

```typescript
interface IntegrationTestContext {
  /**
   * Base URL of the test server endpoint
   * @example "http://localhost:3000/api/update"
   * @example "https://my-worker.my-account.workers.dev/update"
   */
  serverUrl: string;

  /**
   * Function to seed database with test bundles before a test runs.
   * This should insert the bundles into the database/storage backend.
   */
  seedBundles: (bundles: Bundle[]) => Promise<void>;

  /**
   * Function to clear all bundles from database between tests.
   * This ensures test isolation.
   */
  clearBundles: () => Promise<void>;

  /**
   * Optional custom headers for authentication or other purposes.
   * @example { "Authorization": "Bearer token123" }
   */
  headers?: Record<string, string>;
}
```

### fetchUpdateInfo

```typescript
async function fetchUpdateInfo(
  context: IntegrationTestContext,
  args: GetBundlesArgs,
): Promise<UpdateInfo | null>
```

Helper function to make HTTP POST requests for update checks.

**Parameters:**
- `context`: Integration test context with server URL and headers
- `args`: GetBundlesArgs parameters (platform, bundleId, appVersion/fingerprintHash, etc.)

**Returns:**
- `UpdateInfo` object if update is available
- `null` if no update available (HTTP 404 or empty response)

**Throws:**
- `Error` for non-2xx/404 HTTP status codes

**Example:**
```typescript
const update = await fetchUpdateInfo(context, {
  platform: 'ios',
  bundleId: '00000000-0000-0000-0000-000000000000',
  appVersion: '1.0.0',
  channel: 'production',
  _updateStrategy: 'appVersion'
});
```

### setupGetUpdateInfoIntegrationTestSuite

```typescript
function setupGetUpdateInfoIntegrationTestSuite(
  context: IntegrationTestContext
): void
```

Sets up the complete integration test suite with 100+ test cases.

**Test Coverage:**
- ✅ App version strategy (45 tests)
  - Wildcard version matching
  - Semver compatibility
  - Force update behavior
  - Rollback scenarios
  - Channel isolation
  - minBundleId filtering
  - Disabled bundle handling

- ✅ Fingerprint strategy (45 tests)
  - Hash-based matching
  - Bundle ordering
  - Force update behavior
  - Rollback scenarios
  - Channel isolation
  - minBundleId filtering
  - Disabled bundle handling

## Test Data

The test suite uses predefined bundle templates that can be customized:

```typescript
// App version strategy template
const DEFAULT_BUNDLE_APP_VERSION_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  fingerprintHash: null,
} as const;

// Fingerprint strategy template
const DEFAULT_BUNDLE_FINGERPRINT_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  targetAppVersion: null,
} as const;
```

## Best Practices

### 1. Test Isolation

Always clear database state between tests:

```typescript
beforeEach(async () => {
  await clearBundles();
});
```

The framework calls `clearBundles()` automatically via `beforeEach`.

### 2. Server Lifecycle Management

Properly start and stop test servers:

```typescript
beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});
```

### 3. Error Handling

Implement robust error handling in seed/clear functions:

```typescript
async function seedBundles(bundles: Bundle[]): Promise<void> {
  try {
    await db.insertBundles(bundles);
  } catch (error) {
    console.error('Failed to seed bundles:', error);
    throw error; // Re-throw to fail the test
  }
}
```

### 4. Timeout Configuration

Set appropriate timeouts for slow operations:

```vitest
import { describe, it } from 'vitest';

describe('integration tests', () => {
  it('should handle slow queries', async () => {
    // Test code
  }, { timeout: 10000 }); // 10 second timeout
});
```

### 5. Parallel Test Execution

Be cautious with parallel execution when using shared databases:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: 'forks', // Use separate processes
    poolOptions: {
      forks: {
        singleFork: true // Run tests sequentially
      }
    }
  }
});
```

## Troubleshooting

### Issue: Tests fail with 404 errors

**Cause:** Server not started or wrong URL

**Solution:** Verify server is running and URL is correct:
```typescript
console.log('Server URL:', serverUrl);
const response = await fetch(serverUrl);
console.log('Server status:', response.status);
```

### Issue: Tests timeout

**Cause:** Slow database operations or server startup

**Solution:** Increase test timeout:
```typescript
describe('integration tests', () => {
  setupGetUpdateInfoIntegrationTestSuite(context);
}, { timeout: 30000 }); // 30 seconds
```

### Issue: Database not cleared between tests

**Cause:** clearBundles() implementation incomplete

**Solution:** Verify all test data is removed:
```typescript
async function clearBundles(): Promise<void> {
  await db.query('DELETE FROM bundles');

  // Verify deletion
  const count = await db.query('SELECT COUNT(*) FROM bundles');
  if (count.rows[0].count > 0) {
    throw new Error('Failed to clear all bundles');
  }
}
```

### Issue: Authentication errors

**Cause:** Missing or incorrect headers

**Solution:** Add required authentication headers:
```typescript
setupGetUpdateInfoIntegrationTestSuite({
  serverUrl: 'https://api.example.com/update',
  seedBundles,
  clearBundles,
  headers: {
    'Authorization': `Bearer ${process.env.TEST_API_TOKEN}`,
    'X-API-Key': process.env.TEST_API_KEY
  }
});
```

## Migration from Unit Tests

If you're currently using `setupGetUpdateInfoTestSuite` (unit tests), here's how to migrate:

### Before (Unit Tests)

```typescript
import { setupGetUpdateInfoTestSuite } from '@hot-updater/core/test-utils';

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    // Direct function call with mocked data
    return await myGetUpdateInfoFunction(bundles, args);
  }
});
```

### After (Integration Tests)

```typescript
import { setupGetUpdateInfoIntegrationTestSuite } from '@hot-updater/core/test-utils';

setupGetUpdateInfoIntegrationTestSuite({
  serverUrl: 'http://localhost:3000/api/update',
  seedBundles: async (bundles) => {
    await db.insertBundles(bundles);
  },
  clearBundles: async () => {
    await db.query('DELETE FROM bundles');
  }
});
```

### Key Differences

| Unit Tests | Integration Tests |
|------------|------------------|
| Direct function calls | HTTP requests |
| Mocked dependencies | Real database |
| Fast execution | Slower but realistic |
| Test logic only | Test entire stack |
| No server required | Requires running server |

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Integration Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Start test server
        run: npm run start:test &

      - name: Wait for server
        run: npx wait-on http://localhost:3000/health

      - name: Run integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
```

## Related Resources

- [Vitest API Documentation](https://vitest.dev/api/)
- [Vitest Configuration Guide](https://vitest.dev/config/)
- [Original Unit Test Suite](./setupGetUpdateInfoTestSuite.ts)
- [Hot Updater Core Types](../types.ts)

## Contributing

When adding new test cases:

1. Add to both app version and fingerprint strategy sections
2. Use descriptive test names
3. Document expected behavior in comments
4. Ensure test isolation with proper cleanup
5. Test both success and error scenarios

## License

MIT - See LICENSE file in repository root

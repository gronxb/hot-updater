# Integration Testing Framework

## Overview

This document describes the integration testing framework for hot-updater. The framework has been migrated from unit-level mocking to full HTTP-based integration tests that validate the entire request/response cycle against virtual or emulated provider infrastructure.

## Architecture

### Core Test Suite

The integration test suite is defined in `@hot-updater/core/test-utils` and provides:

- **setupGetUpdateInfoIntegrationTestSuite**: A comprehensive test suite with all test cases from the original unit tests
- **IntegrationTestContext**: An interface defining the contract for provider-specific test implementations

### Test Context Interface

Each provider must implement the `IntegrationTestContext` interface:

```typescript
interface IntegrationTestContext {
  setupBundles: (bundles: Bundle[]) => Promise<void>;
  cleanup: () => Promise<void>;
  fetchUpdateInfo: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
}
```

- **setupBundles**: Inserts bundle data into the provider's database/storage
- **cleanup**: Resets the test environment between tests
- **fetchUpdateInfo**: Makes actual HTTP requests to the provider's endpoint

## Provider Implementations

### 1. Cloudflare Workers (@cloudflare/vitest-pool-workers)

**Location**: `plugins/cloudflare/worker/src/integration.spec.ts`

**Test Environment**:
- Uses `@cloudflare/vitest-pool-workers` for native Workers testing
- Tests run in actual Workers runtime environment
- D1 database operations are real

**Running Tests**:
```bash
pnpm test plugins/cloudflare/worker/src/integration.spec.ts
```

**Key Features**:
- Native Workers environment via Cloudflare's test pool
- Real D1 database queries
- Actual Hono routing
- No mocking required

**Documentation**: See `plugins/cloudflare/vitest.config.mts` for configuration

---

### 2. Firebase Functions (Firebase Emulator)

**Location**: `plugins/firebase/firebase/functions/integration.spec.ts`

**Test Environment**:
- Firebase Functions Emulator
- Firestore Emulator
- Real HTTP requests to emulated endpoints

**Setup Required**:
1. Start Firebase emulators:
   ```bash
   cd plugins/firebase/firebase
   firebase emulators:start
   ```

2. Run tests (in separate terminal):
   ```bash
   pnpm test plugins/firebase/firebase/functions/integration.spec.ts
   ```

**Key Features**:
- Full Firebase Functions emulation
- Real Firestore queries
- Signed URL generation
- HTTP header parsing

**Documentation**: `plugins/firebase/firebase/functions/INTEGRATION_TESTS.md`

---

### 3. Supabase Edge Functions (Supabase CLI)

**Location**: `plugins/supabase/supabase/edge-functions/integration.spec.ts`

**Test Environment**:
- Supabase local development environment
- PostgreSQL database
- Deno-based Edge Functions runtime

**Setup Required**:
1. Start Supabase local:
   ```bash
   cd plugins/supabase/supabase
   supabase start
   supabase db reset  # Apply migrations
   ```

2. Serve edge functions:
   ```bash
   supabase functions serve hot-updater --no-verify-jwt
   ```

3. Run tests (in separate terminal):
   ```bash
   pnpm test plugins/supabase/supabase/edge-functions/integration.spec.ts
   ```

**Key Features**:
- Real PostgreSQL stored procedures
- Edge Function HTTP routing
- Supabase client integration
- Database migrations

**Documentation**: `plugins/supabase/supabase/edge-functions/INTEGRATION_TESTS.md`

---

### 4. AWS Lambda@Edge (Mocked CDN)

**Location**: `plugins/aws/lambda/integration.spec.ts`

**Test Environment**:
- Mocked CloudFront CDN responses
- Real Lambda business logic
- No AWS infrastructure required

**Running Tests**:
```bash
pnpm test plugins/aws/lambda/integration.spec.ts
```

**Key Features**:
- CDN-based architecture simulation
- JSON file structure validation
- Signed URL generation (mocked)
- No AWS credentials needed

**Documentation**: `plugins/aws/lambda/INTEGRATION_TESTS.md`

**Note**: Due to CloudFront's complex infrastructure requirements, this implementation uses mocked fetch calls to simulate CDN responses. For real-world testing, deploy to AWS and test against actual CloudFront distributions.

---

## Test Coverage

All provider implementations test the complete set of scenarios including:

### App Version Strategy
- Wildcard version matching (`*`)
- Semver compatibility (`1.x.x`, `1.0`)
- Bundle ID comparisons
- MinBundleId filtering
- Channel isolation
- Force update logic
- Rollback scenarios
- Disabled bundle handling

### Fingerprint Strategy
- Fingerprint hash matching
- Bundle versioning
- MinBundleId filtering
- Channel isolation
- Force update logic
- Rollback scenarios
- Disabled bundle handling

### Edge Cases
- Empty bundle lists
- Non-existent bundles
- Conflicting version requirements
- Multiple enabled/disabled bundles
- Up-to-date clients

## Migration from Unit Tests

The original unit tests in `setupGetUpdateInfoTestSuite` remain for backward compatibility and faster execution. The new integration tests provide:

1. **Real HTTP validation**: Tests make actual fetch() calls
2. **Database integration**: Tests interact with real databases (or emulated)
3. **End-to-end coverage**: Tests validate the entire stack from HTTP to response
4. **Provider-specific logic**: Tests catch provider-specific bugs

## Adding New Providers

To add integration tests for a new provider:

1. Implement `IntegrationTestContext` interface:
   ```typescript
   import { setupGetUpdateInfoIntegrationTestSuite, type IntegrationTestContext } from "@hot-updater/core/test-utils";

   const context: IntegrationTestContext = {
     setupBundles: async (bundles) => {
       // Insert bundles into your provider's database
     },
     cleanup: async () => {
       // Clean up test data
     },
     fetchUpdateInfo: async (args) => {
       // Make HTTP request to your endpoint
       // Return UpdateInfo or null
     },
   };

   setupGetUpdateInfoIntegrationTestSuite(context);
   ```

2. Set up provider-specific test environment (emulators, local servers, etc.)

3. Document setup instructions in a provider-specific INTEGRATION_TESTS.md file

## Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Always clean up after tests
3. **Real Requests**: Use actual HTTP calls, not mocks (except where infrastructure is prohibitive)
4. **Documentation**: Document setup requirements clearly
5. **CI/CD**: Consider environment-specific test suites for CI

## CI/CD Considerations

### Cloudflare Workers
- ✅ Runs in CI without special setup
- Uses Cloudflare's test pool

### Firebase
- ⚠️ Requires Firebase emulator in CI
- Can use Docker containers with Firebase tools

### Supabase
- ⚠️ Requires Supabase local + Docker in CI
- Can use GitHub Actions with Supabase CLI

### AWS Lambda@Edge
- ✅ Runs in CI without special setup (uses mocks)
- Real AWS testing requires deployed infrastructure

## Future Improvements

1. **Parallel Test Execution**: Run provider tests concurrently
2. **Performance Benchmarks**: Measure response times
3. **Load Testing**: Validate behavior under high load
4. **Real AWS Testing**: Add optional real CloudFront integration tests
5. **Docker Compose**: Provide unified environment for all emulators

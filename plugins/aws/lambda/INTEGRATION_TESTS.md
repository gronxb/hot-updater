# AWS Lambda@Edge Integration Tests

## Overview

These integration tests validate the hot-updater AWS Lambda@Edge implementation by simulating CloudFront CDN responses through mocked fetch calls. The tests verify that the Lambda function correctly processes the CDN's JSON structure and returns appropriate update information.

## Architecture

AWS Lambda@Edge for hot-updater works by:
1. Storing bundle metadata as JSON files in S3
2. Distributing via CloudFront CDN
3. Lambda@Edge functions fetch these JSON files to determine updates

Since Lambda@Edge requires CloudFront infrastructure, these tests mock the CDN layer while testing the actual Lambda business logic.

## Running Integration Tests

No special setup required - these tests use mocked fetch calls:

```bash
pnpm test plugins/aws/lambda/integration.spec.ts
```

## How It Works

### Test Setup
1. **Bundle Storage Simulation**: Tests create a virtual CDN structure in memory
2. **Path Structure**:
   - App Version Strategy: `{channel}/{platform}/target-app-versions.json` and `{channel}/{platform}/{version}/update.json`
   - Fingerprint Strategy: `{channel}/{platform}/{fingerprintHash}/update.json`

### Test Execution
1. Tests populate the mock CDN with JSON files based on bundle data
2. The Lambda function fetches these files via mocked `fetch()` calls
3. Tests verify the Lambda correctly processes the JSON and returns expected updates

### Verification
Tests ensure:
- Correct CDN paths are requested
- JSON responses are parsed correctly
- Update logic (semver matching, rollback, etc.) works as expected
- Signed URLs are generated (mocked)

## Real-World Testing

For testing against actual AWS infrastructure:

1. **Deploy to AWS**:
   ```bash
   npx hot-updater deploy
   ```

2. **Test Against Real CloudFront**:
   Update the test configuration to use your CloudFront distribution:
   ```typescript
   const BASE_URL = "https://your-distribution.cloudfront.net";
   const KEY_PAIR_ID = "your-key-pair-id";
   const PRIVATE_KEY = "your-private-key";
   ```

3. **Remove Mocks**:
   Comment out the `vi.mock()` calls to use real CloudFront signing

## Limitations

- These tests mock the CloudFront CDN layer
- Real CloudFront behavior (caching, edge locations) is not tested
- For full end-to-end testing, deploy to AWS and test against real infrastructure

## Benefits of Mock-Based Testing

- No AWS credentials required
- Fast execution (no network calls)
- Deterministic results
- Can test error scenarios easily
- Works in CI/CD without AWS access

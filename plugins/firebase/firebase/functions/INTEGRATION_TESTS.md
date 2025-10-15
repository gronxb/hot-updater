# Firebase Functions Integration Tests

## Overview

These integration tests validate the hot-updater Firebase Functions by making actual HTTP requests to the Functions emulator and verifying responses against a live Firestore emulator.

## Prerequisites

1. Install Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```

2. Install Firebase emulators:
   ```bash
   firebase init emulators
   ```

## Running Integration Tests

### Start the Firebase Emulators

In one terminal, start the Firebase emulators:

```bash
cd plugins/firebase/firebase
firebase emulators:start
```

This will start:
- Firestore Emulator on `localhost:8080`
- Functions Emulator on `localhost:5001`

### Run the Tests

In another terminal, run the integration tests:

```bash
pnpm test plugins/firebase/firebase/functions/integration.spec.ts
```

## Configuration

The integration tests use the following emulator configuration:
- **Project ID**: `get-update-info-integration-test`
- **Firestore Emulator**: `127.0.0.1:8080`
- **Functions Emulator**: `127.0.0.1:5001`

These can be modified in the test file if needed.

## How It Works

1. **Setup**: Tests insert bundle data into the Firestore emulator
2. **Execution**: Tests make HTTP requests to the Functions emulator endpoint
3. **Verification**: Tests verify the response matches expected update logic
4. **Cleanup**: Tests clean up Firestore collections after each test

This approach ensures tests validate the entire request/response cycle including:
- HTTP header parsing
- Firestore queries
- Response formatting
- Error handling

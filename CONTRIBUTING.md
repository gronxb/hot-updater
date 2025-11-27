# Contributing to hot-updater

Thank you for your interest in contributing! This guide outlines the necessary steps to get your development environment set up, make changes, and submit them for review.

---

## 1. Setting Up Your Development Environment

Get your local machine ready to work on `hot-updater`.

### Steps

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/gronxb/hot-updater.git
   cd hot-updater
   ```

2. **Enable `corepack`:**

   ```bash
   # Install corepack globally
   npm install -g corepack

   # Enable corepack
   corepack enable
   ```

3. **Install Dependencies:**
   Install dependencies for all packages in the monorepo:

   ```bash
   pnpm install
   ```

4. **Initial Project Build:**
   Compile all packages within the workspace:

   ```bash
   pnpm -w build
   ```

   *(The `-w` flag targets the workspace root)*

---

## 2. Running the Examples

Test the library’s functionality using the provided example applications.

### 1. Navigate to Example

Navigate to the example application directory:

```bash
cd examples/v0.71.19
```

### 2. OTA and Infrastructure Setup

To test OTA update functionality, release mode is required (`--mode Release`). Additionally, you might need to initialize your OTA infrastructure:

```bash
pnpm hot-updater init
```

For a quick and easy setup, Supabase is a good option for hosting and managing OTA updates.

### 3. Run on iOS

```bash
pnpx pod-install
pnpm ios
pnpm start --reset-cache
```

To test Over-the-Air (OTA) updates, run the app in release mode:

```bash
pnpm ios --mode Release
```

### 4. Run on Android

To start the Android example app in development mode:

```bash
pnpm android
pnpm start --reset-cache
```

To test OTA updates on Android:

```bash
pnpm android --mode Release
```

---

## 3. Making Changes (Development Workflow)

Follow these steps when modifying the library's code.

1. **Edit Code:** Make your desired code changes, typically within the `packages/` directory.
2. **Rebuild:** After making changes to the core library code, you **must** rebuild the workspace:

   ```bash
   pnpm -w build
   ```

   For development with automatic rebuilding on file changes, use:

   ```bash
   pnpm -w build:dev
   ```

   This will watch for changes in `docs/`, `packages/`, and `plugins/` directories and automatically trigger rebuilds.

3. **Test:** Rerun the examples or add specific tests to verify your changes work as expected.

---

## 4. Submitting a Pull Request (PR)

Ready to contribute your changes back? Follow this checklist before submitting your PR.

### PR Preparation Checklist

1. **Format and Lint**
   Format and lint the entire codebase to ensure code consistency and style correctness.

   ```bash
   pnpm -w biome
   ```

   Review and fix any reported issues.

2. **Unit Test**
   Run the unit tests to verify the correctness and behavior of the codebase.

   ```bash
   pnpm -w test
   ```

   Ensure all tests pass without errors.

3. **Create a Changeset**
   Use `changeset` to describe the changes you have made. This helps maintain clear changelogs and manage releases efficiently.

   ```bash
   pnpm changeset
   ```

   Follow the interactive prompts to select affected packages and describe your changes. Typically, you'll select the type of change:

   * `patch`: bug fixes, minor improvements.
   * `minor`: when native code has changed.

4. **Commit and Push**
   Include the changeset files with your commits and push your branch:

   ```bash
   git add .changeset
   git commit -m "your commit message"
   git push origin <your-branch-name>
   ```

Finally, open a Pull Request (PR) in GitHub to submit your changes for review.

Thank you again for contributing!

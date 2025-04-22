# Contributing to hot-updater

Thank you for your interest in contributing! This guide outlines the necessary steps to get your development environment set up, make changes, and submit them for review.

---

## 1. Setting Up Your Development Environment

Get your local machine ready to work on `hot-updater`.

### Steps

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/gronxb/hot-updater.git
    cd hot-updater
    ```

2.  **enable `corepack`:**
    ```bash
    # Install corepack globally
    sudo npm install -g corepack

    # Enable corepack
    corepack enable
    ```

3.  **Install Dependencies:**
    Install dependencies for all packages in the monorepo:
    ```bash
    pnpm install
    ```

4.  **Initial Project Build:**
    Compile all packages within the workspace:
    ```bash
    pnpm -w build
    ```
    *(The `-w` flag targets the workspace root)*

---

## 2. Running the Examples

## Test the library's functionality using the provided example applications.

1. **Navigate to Example:**
   ```bash
   cd examples/v0.71.19
   ```
Note: It's recommended to use the minimum version available in the examples folder (currently v0.71.19). Supporting the minimum version typically ensures compatibility with higher versions as well.

2.  **Run on iOS:**
    ```bash
    pnpx pod-install
    pnpm ios
    pnpm start --reset-cache
    ```

3.  **Run on Android:**
    ```bash
    pnpm android
    pnpm start --reset-cache
    ```

if yot want to start bundler dev mode
    ```bash
    pnpm start --reset-cache
    ```

*(Note: You might need to modify example code temporarily for testing, but remember to discard these changes before submitting a PR).*

---

## 3. Making Changes (Development Workflow)

Follow these steps when modifying the library's code.

1.  **Edit Code:** Make your desired code changes, typically within the `packages/` directory.
2.  **Rebuild:** After making changes to the core library code, you **must** rebuild the workspace:
    ```bash
    pnpm -w build
    ```
3.  **Test:** Rerun the examples or add specific tests to verify your changes work as expected.

---

## 4. Submitting a Pull Request (PR)

Ready to contribute your changes back? Follow this checklist before submitting your PR.

### PR Preparation Checklist

1.  **Format and Lint:**
    Ensure code consistency by running the Biome formatter/linter across the workspace.
    ```bash
    pnpm -w biome
    ```
    Fix any reported issues.


Thank you again for contributing!

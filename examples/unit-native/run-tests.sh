#!/bin/bash

set -e

echo "================================"
echo "Running Native Unit Tests"
echo "================================"

# Track test results
IOS_RESULT=0
ANDROID_RESULT=0

# Run iOS tests
echo ""
echo "Running iOS Swift tests..."
echo "--------------------------------"
cd ios
if swift test; then
  echo "✓ iOS tests passed"
else
  echo "✗ iOS tests failed"
  IOS_RESULT=1
fi
cd ..

# Run Android tests
echo ""
echo "Running Android Kotlin tests..."
echo "--------------------------------"
cd android
if ./gradlew test --console=plain; then
  echo "✓ Android tests passed"
else
  echo "✗ Android tests failed"
  ANDROID_RESULT=1
fi
cd ..

# Summary
echo ""
echo "================================"
echo "Test Summary"
echo "================================"
if [ $IOS_RESULT -eq 0 ]; then
  echo "✓ iOS: PASSED"
else
  echo "✗ iOS: FAILED"
fi

if [ $ANDROID_RESULT -eq 0 ]; then
  echo "✓ Android: PASSED"
else
  echo "✗ Android: FAILED"
fi
echo "================================"

# Exit with error if any tests failed
if [ $IOS_RESULT -ne 0 ] || [ $ANDROID_RESULT -ne 0 ]; then
  exit 1
fi

echo ""
echo "All native tests passed!"
exit 0

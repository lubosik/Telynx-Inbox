#!/bin/sh
#
# Runs after dependency resolution, immediately before xcodebuild.
#
# Stamps the App Store build number. TestFlight rejects a build whose
# CFBundleVersion has already been used, so it must come from the CI counter
# rather than the value committed in Info.plist.
#
set -e

PLIST="$CI_PRIMARY_REPOSITORY_PATH/ios/ViciInbox/Resources/Info.plist"

if [ -z "$CI_BUILD_NUMBER" ]; then
  echo "CI_BUILD_NUMBER not set — leaving Info.plist untouched"
  exit 0
fi

if [ ! -f "$PLIST" ]; then
  echo "ERROR: Info.plist not found at $PLIST"
  exit 1
fi

echo "stamping CFBundleVersion = $CI_BUILD_NUMBER"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $CI_BUILD_NUMBER" "$PLIST"

# Confirm it took — a silent failure here surfaces much later as a
# rejected TestFlight upload.
WROTE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST")
echo "CFBundleVersion now: $WROTE"
[ "$WROTE" = "$CI_BUILD_NUMBER" ] || { echo "ERROR: stamp did not apply"; exit 1; }

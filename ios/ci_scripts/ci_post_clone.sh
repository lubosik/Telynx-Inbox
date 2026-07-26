#!/bin/sh
#
# Xcode Cloud runs this immediately after cloning the repo, before resolving
# dependencies. Xcode Cloud looks for ci_scripts/ next to the Xcode project.
#
set -e

echo "── Vici Inbox — post-clone ─────────────────────────────────"
echo "workflow:    ${CI_WORKFLOW:-?}"
echo "build:       ${CI_BUILD_NUMBER:-?}"
echo "branch:      ${CI_BRANCH:-?}"
echo "commit:      ${CI_COMMIT:-?}"
echo "xcode:       $(xcodebuild -version 2>/dev/null | head -1)"

# The project is committed, so there is nothing to generate here. If source
# files were added without regenerating, the build would fail confusingly —
# so verify the project references every Swift file on disk.
PROJ="$CI_PRIMARY_REPOSITORY_PATH/ios/ViciInbox.xcodeproj/project.pbxproj"
SRC="$CI_PRIMARY_REPOSITORY_PATH/ios/ViciInbox"

if [ -f "$PROJ" ]; then
  missing=0
  for f in $(find "$SRC" -name "*.swift" -exec basename {} \; | sort); do
    if ! grep -q "$f" "$PROJ"; then
      echo "ERROR: $f exists on disk but is not in the Xcode project."
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    echo "Run: python3 ios/scripts/generate-xcodeproj.py && commit the result"
    exit 1
  fi
  echo "project: all Swift files referenced"
else
  echo "ERROR: $PROJ not found"
  exit 1
fi

echo "── post-clone OK ───────────────────────────────────────────"

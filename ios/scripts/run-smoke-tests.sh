#!/usr/bin/env bash
#
# ios/scripts/run-smoke-tests.sh — run the pure-Foundation model tests.
#
# WHY THESE EXIST IN THIS ODD FORM
#   This Mac cannot build the app: macOS 13.7.5, Command Line Tools only, no
#   Xcode, and Xcode 26 needs macOS 15.6. See BUILD-ENVIRONMENT.md. So the app
#   itself is only ever compiled by GitHub Actions.
#
#   The files in ios/Tests are the exception. They are standalone `@main`
#   executables that import nothing but Foundation, so `swiftc` from the
#   Command Line Tools compiles them here in about two seconds. That makes them
#   the ONLY iOS check that can run before pushing, which is why the wire
#   contracts between the Node API and the Swift models live in them.
#
# WHY A SCRIPT RATHER THAN A COMMAND IN A DOC
#   Each test needs its model file plus that file's transitive dependencies,
#   and Swift gives you one missing symbol per attempt. Working out that
#   CampaignModels.swift also needs AccountModels, MobileModels,
#   AnalyticsModels, SegmentModels, ExperienceModels and CallModels took six
#   compile-and-read cycles. The closure is recorded here so nobody does that
#   twice.
#
#   They are deliberately NOT in ios-build.yml. That workflow's job is to
#   typecheck the real app against the real SDK, which subsumes this; these are
#   the local fast path, not the authority.
#
# Usage:  ios/scripts/run-smoke-tests.sh [TestName ...]
#         With no arguments, runs every test that has a known closure below.

set -euo pipefail

cd "$(dirname "$0")/../.."
CORE=ios/ViciInbox/Core
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# Everything CampaignModels.swift transitively needs. Shared by the campaign
# and proposal tests.
CAMPAIGN_DEPS=(
  "$CORE/CampaignModels.swift"
  "$CORE/AccountModels.swift"
  "$CORE/MobileModels.swift"
  "$CORE/AnalyticsModels.swift"
  "$CORE/SegmentModels.swift"
  "$CORE/ExperienceModels.swift"
  ios/ViciInbox/Voice/CallModels.swift
)

closure_for() {
  case "$1" in
    CampaignPreviewModelsSmoke|CampaignProposalModelsSmoke)
      printf '%s\n' "${CAMPAIGN_DEPS[@]}"
      # CampaignProposalModels is a separate file from CampaignModels.
      # Written as an `if` rather than `[ ... ] && echo`, because the && form
      # returns 1 when the test is false and that becomes the function's exit
      # status, which the caller reads as "no closure recorded".
      if [ "$1" = CampaignProposalModelsSmoke ]; then
        echo "$CORE/CampaignProposalModels.swift"
      fi
      ;;
    *) return 1 ;;
  esac
}

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  names=(CampaignPreviewModelsSmoke CampaignProposalModelsSmoke)
fi

failed=0
for name in "${names[@]}"; do
  source_file="ios/Tests/$name.swift"
  if [ ! -f "$source_file" ]; then
    echo "SKIP  $name (no such file)"
    continue
  fi
  if ! deps=$(closure_for "$name"); then
    echo "SKIP  $name (no recorded dependency closure; add one to this script)"
    continue
  fi
  # shellcheck disable=SC2086
  if swiftc -o "$OUT/$name" "$source_file" $deps 2>"$OUT/$name.log" && "$OUT/$name"; then
    :
  else
    echo "FAIL  $name"
    grep "error:" "$OUT/$name.log" | head -10 || true
    failed=1
  fi
done

exit "$failed"

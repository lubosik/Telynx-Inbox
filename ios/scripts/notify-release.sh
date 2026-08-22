#!/usr/bin/env bash
# Tell the testers a TestFlight build is waiting.
#
# Runs from the TestFlight workflow, last and only on success. The publish step
# before it fails unless the build reached VALID and landed in the beta group,
# so by the time this runs the build genuinely exists. Announcing an update that
# is not installable is the failure that ordering prevents.
#
# Targeting is by build staleness, not by person: it reaches devices not already
# on this build. That is self-correcting (a device stops matching once it
# updates) and idempotent (re-running after everyone has updated notifies
# nobody). Device-to-user binding exists but no device is bound yet.
#
# NEVER fails the job. The build has already shipped; a missed push is not a
# reason to mark a successful release red.
#
# Usage: notify-release.sh <build_number> <changelog_file>
# Env:   RELEASE_NOTIFY_URL, RELEASE_NOTIFY_TOKEN
set -uo pipefail

BUILD="${1:?build number required}"
CHANGELOG_FILE="${2:-}"

if [ -z "${RELEASE_NOTIFY_URL:-}" ] || [ -z "${RELEASE_NOTIFY_TOKEN:-}" ]; then
  echo "::notice::RELEASE_NOTIFY_URL/RELEASE_NOTIFY_TOKEN not set - skipping the in-app notification."
  echo "Build ${BUILD} is distributed; testers still receive TestFlight's own alert."
  exit 0
fi

# First line of the release notes, so the push says something specific rather
# than "an update is available". Trimmed to fit a lock screen.
SUMMARY=""
if [ -n "$CHANGELOG_FILE" ] && [ -f "$CHANGELOG_FILE" ]; then
  SUMMARY=$(head -1 "$CHANGELOG_FILE" | cut -c1-140)
fi
[ -z "$SUMMARY" ] && SUMMARY="Update from TestFlight to get the latest changes."

# Built with node rather than string interpolation so a quote or a backslash in
# the release notes cannot produce malformed JSON.
BODY=$(BUILD="$BUILD" SUMMARY="$SUMMARY" node -e '
  const build = Number(process.env.BUILD);
  process.stdout.write(JSON.stringify({
    belowBuild: build,
    title: "New update available",
    body: `Build ${build} is ready in TestFlight. ${process.env.SUMMARY}`,
    collapseId: `vici-release-${build}`,
    dryRun: false
  }));
')

echo "Notifying devices not yet on build ${BUILD}"
if curl -sS --max-time 30 --fail-with-body \
     -X POST "${RELEASE_NOTIFY_URL%/}/admin/release-notify" \
     -H "Authorization: Bearer ${RELEASE_NOTIFY_TOKEN}" \
     -H 'Content-Type: application/json' \
     -d "$BODY"; then
  echo
else
  echo
  echo "::warning::Release notification failed. Build ${BUILD} still shipped and is installable."
fi
exit 0

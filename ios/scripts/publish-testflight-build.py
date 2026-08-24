#!/usr/bin/env python3
"""Attach release notes to the newest TestFlight build and hand it to testers.

fastlane cannot do this for us. `upload_to_testflight` is run with
skip_waiting_for_build_processing:true, because waiting makes the step hang
long enough to hit the job timeout — a build uploaded fine on 20 Aug 2026 and
the workflow still reported "cancelled" an hour later. But a changelog cannot
be applied while skipping the wait, so passing both silently produced an empty
release note and testers saw nothing describing the build.

So the upload step uploads, and this sets the notes and distributes afterwards
through the App Store Connect API, which needs no processing wait.

The build is selected by EXACT version, never by "newest". Apple takes minutes
to process an upload, so at the moment this runs the build just pushed is often
not yet the newest VALID one — on 21 Aug 2026 that made this script attach the
notes to the PREVIOUS build and redistribute it, while reporting success. A
green workflow said nothing about whether the intended build reached anybody.
Selecting by version also removes a second hazard: `sort=-version` orders a
string, so build "9" sorts above build "21".

Usage: publish-testflight-build.py <app_id> <beta_group_id> <changelog_file> <build_version>
Requires ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 in the environment.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"


def token():
    try:
        import jwt  # PyJWT
    except ImportError:
        sys.exit("PyJWT is required: pip install pyjwt cryptography")
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900,
         "aud": "appstoreconnect-v1"},
        os.environ["ASC_KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def call(method, path, jwt_token, body=None):
    request = urllib.request.Request(
        path if path.startswith("http") else API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + jwt_token,
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"raw": raw.decode("utf-8", "replace")[:400]}


# Apple's processing is usually a couple of minutes, occasionally longer.
PROCESSING_TIMEOUT_SECONDS = 900
PROCESSING_POLL_SECONDS = 20

# Assignment to a beta group is written quickly but reads back slowly. Two
# minutes is far longer than the lag seen on build 34 and still short enough
# that a genuinely refused assignment fails the job rather than hanging it.
DISTRIBUTION_TIMEOUT_SECONDS = 120
DISTRIBUTION_POLL_SECONDS = 10


def await_build(app_id, version, jwt_token):
    """The build with this exact version, once Apple has finished processing it.

    Returns its id. Exits non-zero rather than falling back to another build:
    publishing the wrong one silently is the failure this function exists to
    prevent.
    """
    deadline = time.time() + PROCESSING_TIMEOUT_SECONDS
    seen = None
    while time.time() < deadline:
        status, payload = call(
            "GET", f"/builds?filter[app]={app_id}&filter[version]={version}&limit=1", jwt_token)
        if status != 200:
            sys.exit(f"could not read builds: {status} {payload}")

        rows = payload.get("data") or []
        if rows:
            attributes = rows[0]["attributes"]
            state = attributes.get("processingState")
            if state != seen:
                print(f"build {version}: {state}")
                seen = state
            if state == "VALID":
                if attributes.get("expired"):
                    sys.exit(f"build {version} is already expired")
                return rows[0]["id"]
            if state in ("FAILED", "INVALID"):
                sys.exit(f"build {version} finished processing as {state} — it cannot be distributed")
        elif seen is None:
            print(f"build {version}: not visible to App Store Connect yet")
            seen = "pending"

        time.sleep(PROCESSING_POLL_SECONDS)

    sys.exit(
        f"build {version} did not become VALID within {PROCESSING_TIMEOUT_SECONDS}s. "
        "It may still be processing; re-run this step rather than assuming it shipped.")


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    app_id, group_id, changelog_path, build_version = sys.argv[1:5]

    with open(changelog_path, encoding="utf-8") as handle:
        notes = handle.read().strip()
    if not notes:
        sys.exit("changelog file is empty — testers would get a blank release note")

    jwt_token = token()

    build_id = await_build(app_id, build_version, jwt_token)
    version = build_version

    # fastlane may already have created an empty localisation, so update in
    # place when one exists rather than failing on the duplicate.
    status, existing = call("GET", f"/builds/{build_id}/betaBuildLocalizations", jwt_token)
    current = next((row for row in existing.get("data", [])
                    if row["attributes"]["locale"] == "en-US"), None)

    if current:
        status, payload = call(
            "PATCH", f"/betaBuildLocalizations/{current['id']}", jwt_token,
            {"data": {"type": "betaBuildLocalizations", "id": current["id"],
                      "attributes": {"whatsNew": notes}}})
    else:
        status, payload = call(
            "POST", "/betaBuildLocalizations", jwt_token,
            {"data": {"type": "betaBuildLocalizations",
                      "attributes": {"locale": "en-US", "whatsNew": notes},
                      "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}})
    if status >= 300:
        sys.exit(f"could not set release notes: {status} {payload}")
    print("release notes attached")

    # Already-assigned is the normal case when fastlane got that far, and is
    # not a failure — verify the end state rather than trusting the response.
    status, payload = call(
        "POST", f"/betaGroups/{group_id}/relationships/builds", jwt_token,
        {"data": [{"type": "builds", "id": build_id}]})
    print(f"distribute request: {status}")

    # THE READ IS EVENTUALLY CONSISTENT, SO ONE GET IS NOT AN ANSWER.
    #
    # Build 34 failed this step and was, at that moment, already assigned. The
    # POST above answered 422, the immediate GET did not list the group yet, and
    # the job exited 1 on a release that had in fact shipped. Re-running the
    # publish-only path minutes later printed the SAME 422 and then found the
    # group present, which is the proof: the write had landed and only the read
    # was behind.
    #
    # So the POST status tells us nothing on its own. 422 covers both "already
    # assigned" and a genuine refusal, and the end state is the only thing worth
    # trusting. Poll it instead of sampling it once.
    #
    # Failing closed is still right when the group never appears: a build that
    # testers cannot install must not report success. This only stops a race
    # being reported as that.
    deadline = time.time() + DISTRIBUTION_TIMEOUT_SECONDS
    attempt = 0
    while True:
        attempt += 1
        status, payload = call("GET", f"/builds/{build_id}?include=betaGroups", jwt_token)
        groups = [row["id"] for row in
                  payload.get("data", {}).get("relationships", {}).get("betaGroups", {}).get("data", [])]
        if group_id in groups:
            print(f"build {version} is distributed to group {group_id}"
                  + (f" (confirmed on attempt {attempt})" if attempt > 1 else ""))
            return
        if time.time() >= deadline:
            sys.exit(
                f"build {version} is not assigned to {group_id} after "
                f"{DISTRIBUTION_TIMEOUT_SECONDS}s — testers cannot install it")
        print(f"build {version}: group assignment not visible yet, re-checking")
        time.sleep(DISTRIBUTION_POLL_SECONDS)


if __name__ == "__main__":
    main()

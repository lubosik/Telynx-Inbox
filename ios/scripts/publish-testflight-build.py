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

Usage: publish-testflight-build.py <app_id> <beta_group_id> <changelog_file>
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


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    app_id, group_id, changelog_path = sys.argv[1:4]

    with open(changelog_path, encoding="utf-8") as handle:
        notes = handle.read().strip()
    if not notes:
        sys.exit("changelog file is empty — testers would get a blank release note")

    jwt_token = token()

    status, payload = call("GET", f"/builds?filter[app]={app_id}&limit=1&sort=-version", jwt_token)
    if status != 200 or not payload.get("data"):
        sys.exit(f"could not read builds: {status} {payload}")
    build = payload["data"][0]
    build_id = build["id"]
    version = build["attributes"]["version"]
    print(f"newest build: {version} ({build['attributes']['processingState']})")

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

    status, payload = call("GET", f"/builds/{build_id}?include=betaGroups", jwt_token)
    groups = [row["id"] for row in
              payload.get("data", {}).get("relationships", {}).get("betaGroups", {}).get("data", [])]
    if group_id not in groups:
        sys.exit(f"build {version} is not assigned to {group_id} — testers cannot install it")
    print(f"build {version} is distributed to group {group_id}")


if __name__ == "__main__":
    main()

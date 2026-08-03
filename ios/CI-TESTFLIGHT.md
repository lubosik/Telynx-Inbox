# Building and shipping to TestFlight without a Mac

The build runs on a GitHub Actions macOS runner. No local Mac compiles the app,
and no certificate is created by hand.

## Why not Xcode Cloud

It was the first choice and it does not work here. Apple's documentation is
explicit: *"You need to configure your first Xcode Cloud workflow in Xcode."*
The App Store Connect web UI only edits workflows for apps already onboarded,
which is why its Xcode Cloud tab offers nothing but an "Open Xcode" button.

The API can't rescue it either: `POST /v1/ciWorkflows` exists, but it requires
an existing `ciProduct`, and `/v1/ciProducts` is **read-only** — there is no way
to create the product without the Xcode app. Since Xcode 26 needs macOS 15.6
and this Mac is on 13.7.5, that route is closed.

GitHub Actions has no such bootstrap requirement.

## How signing works without touching the developer portal

This is the part that would normally require a Mac and Account Holder access.

`xcodebuild` is run with `-allowProvisioningUpdates` plus an App Store Connect
API key. The workflow is designed to use **cloud-managed signing**, allowing
Xcode to create the distribution certificate and provisioning profile
server-side. Nothing is committed and nobody has to open Certificates,
Identifiers & Profiles — which matters because on an Individual account that
section is locked to the Account Holder.

This configuration was verified end to end on 3 August 2026: GitHub Actions
created an unsigned archive, Xcode's export step obtained cloud-managed
distribution signing, and App Store Connect accepted build 1.0.0 (4) as a valid
TestFlight build.

Two constraints make or break this:

- The key must be a **Team key**, not an Individual key. Individual keys cannot
  use the provisioning endpoints at all.
- The key must have the **Admin** role. Cloud signing is refused otherwise.

The `.p8` filename and contents do not identify the key type. Verify it in App
Store Connect: **Users and Access → Integrations → App Store Connect API → Team
Keys**. The key must appear in that table with the Admin role. A team key also
uses the issuer UUID shown above that table; an individual key uses a different
JWT shape and cannot satisfy this workflow.

## One-time setup

### 1. Create the App Store Connect API key

App Store Connect → **Users and Access** → **Integrations** tab →
**App Store Connect API** → **Team Keys** → **+**

| Field | Value |
|---|---|
| Name | `GitHub Actions CI` |
| Access | **Admin** |

An App Store Connect **Admin** can create this — it does not need the Account
Holder.

Then note three things:

- **Issuer ID** — shown above the key list
- **Key ID** — the 10-character id in the key's row
- **The .p8 file** — download it immediately. Apple allows the download **once**.

### 2. Add three repository secrets

GitHub → repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**

| Secret | Value |
|---|---|
| `ASC_ISSUER_ID` | the issuer UUID |
| `ASC_KEY_ID` | the 10-character key id |
| `ASC_KEY_P8_BASE64` | base64 of the .p8 file (below) |

The .p8 is a multi-line PEM, so it is stored base64-encoded to survive intact:

```bash
base64 -i ~/Downloads/AuthKey_XXXXXXXXXX.p8 | tr -d '\n' | pbcopy
```

That copies it to the clipboard; paste it as the secret value.

### 3. Create the App Store Connect app record

Apps → **+** → **New App**, platform **iOS only**, bundle ID
`com.vicipeptides.inbox`, SKU `vici-inbox-001`. The record must exist before the
first upload.

## Running a build

Run **iOS Build** first. It compiles for the iOS Simulator with signing disabled
and needs no Apple credentials. A failure there is source code, Swift Package
resolution, or simulator compatibility.

GitHub → **Actions** → **iOS → TestFlight** → **Run workflow**.

The TestFlight workflow is manual on purpose because it signs and uploads a
release. The separate source-only workflow is path-filtered to iOS changes.

Expect 15-30 minutes for the first run.

## What the workflow does

| Step | Why |
|---|---|
| Regenerate and diff the project | Fails if the committed project or shared scheme is stale |
| Compile for iOS Simulator | Separates source/package failures from Apple signing failures |
| Write the API key | Decodes the secret, and fails immediately if it isn't a PEM |
| Archive | Creates an unsigned release archive; build number comes from the run number so TestFlight never sees a duplicate |
| Export .ipa | Uses `ExportOptions.plist`, method `app-store-connect`, and applies cloud-managed distribution signing |
| Upload | fastlane `pilot` — `altool` is deprecated and currently broken on Xcode 26 |
| Remove the API key | Runs even if the build failed |

## Installing on the iPhone

Once the build lands in TestFlight: install the TestFlight app, accept the
invite, install Vici Inbox. It then behaves like any normal app on the home
screen; TestFlight only reappears for updates.

Then follow `TESTING.md` — **Test 0 first** (sign in once in the foreground, so
the push token registers with Telnyx), then **Test 1**, the force-quit spike.

## After adding or removing Swift files

```bash
python3 ios/scripts/generate-xcodeproj.py
```

Commit the result. IDs derive from file paths, so regenerating without changes
produces no diff. Forgetting fails the build with the exact command to run.

## Likely first-build failures

**Cloud signing permission error** — the API key is not Admin, or is an
Individual key rather than a Team key. Both are fixed by creating a new key;
roles cannot be changed after creation.

**"No profiles found" / signing errors** — the App Store Connect app record
doesn't exist yet, or the bundle ID doesn't match `com.vicipeptides.inbox`.

**Upload rejected, duplicate build number** — shouldn't happen since the build
number tracks the workflow run number, but re-running an old run would do it.
Start a fresh run rather than re-running.

**Push never arrives after install** — the environment trap. A TestFlight build
is production-signed and gets a production APNs token, which is what
`AppConfig.pushEnvironmentIsProduction` assumes for a Release build. A
locally-sideloaded Debug build would use sandbox instead.

## Runner usage

`lubosik/Telynx-Inbox` is currently public. GitHub's standard hosted runners,
including `macos-26`, are free and unlimited for public repositories. If the
repository becomes private, recheck the plan's included minutes and macOS
multiplier before enabling automatic builds.

# Building and shipping to TestFlight without a Mac

The build runs on a GitHub Actions macOS runner. No Mac of ours ever compiles
the app, and no certificate is created by hand.

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
API key. That switches on **cloud-managed signing**: Xcode creates the
distribution certificate and provisioning profile itself, server-side. Nothing
is stored in a keychain, nothing is committed, and nobody has to open
Certificates, Identifiers & Profiles — which matters because on an Individual
account that section is locked to the Account Holder.

Two constraints make or break this:

- The key must be a **Team key**, not an Individual key. Individual keys cannot
  use the provisioning endpoints at all.
- The key must have the **Admin** role. Cloud signing is refused otherwise.

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

GitHub → **Actions** → **iOS → TestFlight** → **Run workflow**.

It is manual on purpose. This repo takes backend commits constantly, macOS
minutes bill at ten times the Linux rate, and rebuilding the app for a change to
an SMS template is pure waste.

Expect 15-30 minutes for the first run.

## What the workflow does

| Step | Why |
|---|---|
| Verify project references every source file | The project is generated, so a new Swift file could otherwise be silently left out of the build |
| Write the API key | Decodes the secret, and fails immediately if it isn't a PEM |
| Archive | Cloud-managed signing; build number comes from the run number so TestFlight never sees a duplicate |
| Export .ipa | Uses `ExportOptions.plist`, method `app-store-connect` |
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

## Cost

GitHub gives 2,000 free Actions minutes/month on private repos, but macOS bills
at 10x, so that is roughly 200 macOS minutes — about 6-10 builds a month.
Manual triggering keeps this comfortable. Codemagic (500 free macOS minutes) is
the fallback if it gets tight.

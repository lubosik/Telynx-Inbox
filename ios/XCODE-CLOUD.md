# Xcode Cloud setup

Builds the app on Apple's infrastructure with current Xcode and delivers to
TestFlight. Chosen because this Mac cannot build (see `BUILD-ENVIRONMENT.md`) —
Xcode Cloud needs no local Xcode and is included in the $99/year membership
(25 compute hours/month free).

Everything in the repo is ready. What follows is the part that must happen in
Apple's web UI.

## Prerequisites

- [x] App ID `com.vicipeptides.inbox` registered
- [x] VoIP certificate created and uploaded to Telnyx
- [x] `ViciInbox.xcodeproj` committed with a shared `ViciInbox` scheme
- [x] `ci_scripts/` present
- [ ] App record created in App Store Connect
- [ ] Code pushed to GitHub

## 1. Create the App Store Connect record

<https://appstoreconnect.apple.com> → **Apps** → **+** → **New App**

| Field | Value |
|---|---|
| Platforms | iOS |
| Name | Vici Inbox |
| Primary Language | English (U.S.) |
| Bundle ID | `com.vicipeptides.inbox` (now in the dropdown) |
| SKU | `vici-inbox-001` |
| User Access | Full Access |

The name must be unique across the whole App Store. If "Vici Inbox" is taken,
use "Vici Inbox by Vici Peptides" — this is only the store listing name, and
does **not** need to match the name on the home screen.

## 2. Push the code

The iOS app lives in the existing backend repo, so Xcode Cloud points at
`github.com/lubosik/Telynx-Inbox`.

## 3. Create the workflow

App Store Connect → your app → **Xcode Cloud** tab → **Get Started**.

1. **Grant access to GitHub** when prompted (Apple's GitHub app needs read
   access to the repo).
2. **Primary repository:** `lubosik/Telynx-Inbox`, branch `main`.
3. Xcode Cloud scans the repo and should find **`ios/ViciInbox.xcodeproj`** and
   the **`ViciInbox`** scheme. Select them.

Then edit the workflow:

| Section | Setting |
|---|---|
| **Start Conditions** | Delete the default "Branch Changes" trigger and add **Manual** — otherwise every backend commit burns build minutes |
| **Environment** | Xcode: latest release. macOS: latest |
| **Actions** | Remove "Build". Add **Archive**, deployment preparation **TestFlight (Internal Testing Only)** |
| **Post-Actions** | **TestFlight Internal Testing** → add an internal group |

Removing the branch trigger matters: this repo takes backend commits constantly,
and each one would otherwise spend cloud minutes rebuilding an unchanged app.

## 4. First build

**Start Build** in the Xcode Cloud tab. Expect 8-15 minutes for a first run
(dependency resolution is cold).

Watch for these in the logs:
- `── Vici Inbox — post-clone ───` — our script ran
- `project: all Swift files referenced` — project is in sync
- `stamping CFBundleVersion = N` — build number applied
- Resolution of `telnyx-webrtc-ios` from SPM

## 5. Install on the iPhone

Once the build reaches TestFlight, install the TestFlight app from the App
Store, accept the invite, and install Vici Inbox. After that it behaves like a
normal app on the home screen.

Then follow `TESTING.md` — **Test 0 first** (sign in once in the foreground, so
the push token registers with Telnyx), then **Test 1**, the force-quit spike.

## What the CI scripts do

`ci_scripts/ci_post_clone.sh`
Logs the build context and fails fast if a Swift file exists on disk but is
missing from the Xcode project — the most likely breakage, since the project is
generated rather than maintained by Xcode.

`ci_scripts/ci_pre_xcodebuild.sh`
Stamps `CFBundleVersion` from `CI_BUILD_NUMBER`. TestFlight rejects a build
number it has already seen, so this cannot be left to the committed value.

## After adding or removing Swift files

The project is generated, not hand-maintained:

```bash
python3 ios/scripts/generate-xcodeproj.py
```

Commit the result. IDs are derived from file paths, so regenerating without
changes produces an identical file and no diff noise. If you forget,
`ci_post_clone.sh` fails the build with the exact command to run.

On a Mac with Xcode, `xcodegen generate` from `project.yml` does the same job
and is the preferred route; the Python generator exists because XcodeGen cannot
run on macOS 13.

## Known first-build failure modes

**"No signing certificate"** — Xcode Cloud manages signing itself, but the App
Store Connect app record must exist first. Create it before the first build.

**Scheme not found** — the scheme must be *shared*. Ours is committed at
`ViciInbox.xcodeproj/xcshareddata/xcschemes/ViciInbox.xcscheme`.

**Missing compliance answers** — `ITSAppUsesNonExemptEncryption` is already set
to `false` in `Info.plist`, so TestFlight should not prompt.

**Push never arrives after installing** — this is the environment mismatch trap.
A TestFlight build is a production-signed binary, so it gets a production APNs
token. `AppConfig.pushEnvironmentIsProduction` derives this from `#if DEBUG`,
which is correct for a TestFlight archive. If you sideload a Debug build
instead, it will use the sandbox environment.

# Build environment — blocker and options

## The problem

The current development Mac cannot build this app. This is not a configuration
issue; it is a hard version wall.

Verified on 2026-07-25:

| Fact | Value |
|---|---|
| This Mac | MacBook Pro 13" 2019 (`MacBookPro15,4`), Intel i5, 8 GB RAM |
| Current OS | macOS 13.7.5 Ventura |
| Xcode installed | none — Command Line Tools only |
| Free disk | ~9 GB |

Apple's rule, in force since **28 April 2026**: builds uploaded to App Store
Connect **must be made with Xcode 26 or later, using the iOS 26 SDK**.
([Apple developer news](https://developer.apple.com/news/upcoming-requirements/?id=02032026a))

- Xcode 26 requires **macOS 15.6 Sequoia** or later.
- The newest Xcode that runs on macOS 13 Ventura is **Xcode 15.3** — far below
  the requirement.
- Confirmed in practice: `brew install xcodegen` on this machine fails with
  *"Xcode 15.3 cannot be installed on macOS 13. You must upgrade your version of
  macOS."*

So: no TestFlight build can come off this machine as it stands.

## Options

### Option A — Upgrade this Mac (free, ~2-3 hours, some risk)

`MacBookPro15,4` **is** on the macOS Sequoia compatibility list, so the upgrade
path exists:

1. Free up disk. Sequoia needs ~25 GB free to install, and Xcode 26 needs a
   further ~35 GB. Currently there is 9 GB. **This is the real obstacle** —
   roughly 50 GB must be cleared.
2. Upgrade macOS 13.7.5 → Sequoia 15.6+.
3. Install Xcode 26.3 (the Universal build direct from Apple; the `xcodes`
   installer has a known bug on Intel).

Caveats: 8 GB RAM and a 1.4 GHz i5 make Xcode 26 slow but workable. This Mac
cannot run macOS 26 Tahoe (not on the Intel list), so the next time Apple raises
the SDK floor, this machine is stranded for good.

### Option B — Xcode Cloud (recommended)

Included with the $99/year membership: **25 compute hours per month free**.
Builds on Apple's infrastructure with current Xcode and uploads straight to
TestFlight. Workflows can be created and managed from the App Store Connect
website, so **no local Xcode is required**.

Fits this situation well: the code lives in GitHub already, and nothing needs
installing locally. The trade-off is a slower edit → test loop, since every
change goes through a cloud build.

### Option C — GitHub Actions `macos-26` runners

The runner image ships current Xcode 26.x. Pair with Fastlane for signing and
TestFlight upload. Roughly $0.08/minute for private repos. More setup than
Xcode Cloud, more control, and no dependency on Apple's build queue.

### Option D — Borrow or rent a Mac

Any Mac running Sequoia 15.6+ works, including an Apple Silicon machine
belonging to someone else. A rented cloud Mac (MacStadium and similar) is
roughly $99-139/month — hard to justify at this project's size.

## Recommendation

**Option B (Xcode Cloud)** to get the spike done, because it needs no local
install, no macOS upgrade, and no extra spend beyond the membership already
being paid for.

If iteration speed becomes painful — and for CallKit work it may, since every
test needs a real device anyway — clearing 50 GB and doing Option A gives a
proper local loop. The two are not exclusive: Xcode Cloud remains a good release
pipeline afterwards.

## What is unaffected

All application code, configuration, the CSR, and the Telnyx and Apple portal
setup are done or ready. The build machine is purely about *where the compiler
runs*; none of the work above needs redoing whichever option is chosen.

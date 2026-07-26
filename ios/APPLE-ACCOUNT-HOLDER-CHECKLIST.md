# Apple Developer portal — actions for the Account Holder

Everything else is already built. These are the only steps that must be done by
the person who owns the Apple Developer account, because Apple restricts this
section of the portal to the Account Holder.

**You will never be asked for your Apple password or a 2FA code. Do not share them
with anyone, including us.**

Estimated time: **about 10 minutes.**

You need one file from us before you start:

> **`ViciInbox_VoIP.certSigningRequest`**

That is the only file to request, and the only one you need to upload. It contains
no secrets and is safe to send over WhatsApp or email. (The matching private key
never leaves the development Mac, which is exactly how it should be.)

---

## Step 1 — Register the App ID

1. Go to <https://developer.apple.com/account/resources/identifiers/list>
2. Click the blue **+** button
3. Select **App IDs** → **Continue**
4. Select **App** → **Continue**
5. Fill in:
   - **Description:** `Vici Inbox`
   - **Bundle ID:** select **Explicit**, then enter exactly:
     ```
     com.vicipeptides.inbox
     ```
6. Scroll the **Capabilities** list and tick **Push Notifications**
7. Click **Continue** → **Register**

> The Bundle ID must match exactly, including lower case. A typo here means the
> app cannot be signed at all.

---

## Step 2 — Create the VoIP Services Certificate

This is the credential that lets Telnyx wake the iPhone for an incoming call.

1. Go to <https://developer.apple.com/account/resources/certificates/list>
2. Click the blue **+** button
3. Scroll down to the **Services** section and select
   **VoIP Services Certificate** → **Continue**
4. Choose the App ID **`com.vicipeptides.inbox`** from the dropdown → **Continue**
5. When asked to upload a Certificate Signing Request, click **Choose File** and
   select the **`ViciInbox_VoIP.certSigningRequest`** file we sent you
6. Click **Continue**
7. Click **Download** — you will get a file called **`voip_services.cer`**
8. **Send that `voip_services.cer` file back to us.** That is the last thing we
   need from you.

> Do not tick "Sandbox only" if offered. One VoIP Services Certificate covers
> both testing and live use.

---

## Step 3 — Confirm the team access (probably already done)

You already invited `lubosikongwa@icloud.com` to App Store Connect. Please just
confirm the role is **Admin** (not Developer), at
<https://appstoreconnect.apple.com> → **Users and Access**. Admin is what allows
builds to be uploaded and TestFlight to be managed without involving you again.

---

## What happens after this

Once we have `voip_services.cer` we can finish the setup without you. You will
not need to touch the Apple portal again until the certificate expires.

**Put a reminder in your calendar for July 2027: "Renew Vici Inbox VoIP
certificate."** Apple expires these after one year, and when it expires the app
silently stops ringing for incoming calls. Renewing is a repeat of Step 2 and
takes five minutes.

---

## Quick reference

| | |
|---|---|
| Bundle ID | `com.vicipeptides.inbox` |
| Capability to enable | Push Notifications |
| Certificate type | VoIP Services Certificate |
| File you need from us | `ViciInbox_VoIP.certSigningRequest` |
| File to send back to us | `voip_services.cer` |
| Never share | Apple ID password, 2FA codes |

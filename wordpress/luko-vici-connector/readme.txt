=== LUKO Vici Connector ===
Contributors: luko
Tags: woocommerce, sms, abandoned-cart
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 0.3.3
License: Proprietary

Connects authenticated Vici WooCommerce carts to LUKO abandoned-cart recovery while keeping phone availability, SMS consent and push permission independent.

== Installation ==

Upload this ZIP as an upgrade to the existing LUKO Vici Connector. Existing settings and cart data are preserved by additive database upgrades.

Configure the LUKO API base as https://web-production-2551e.up.railway.app and set the same high-entropy signing secret in WordPress and Railway. Prefer defining LUKO_WP_SIGNING_SECRET in wp-config.php rather than storing it in the WordPress options table.

Leave live provider delivery disabled until the LUKO dry-run trace passes and the Telnyx messaging profile is confirmed for this exact cart-reminder use case.

== Changelog ==

= 0.3.3 =
* Adds customer first name and verified WooCommerce product, destination, category, sale and managed-stock facts to signed cart snapshots for the Growth Sales Engine.
* Reuses valid existing billing_phone values and reports carts even when SMS consent is unavailable, without opting the customer in.
* Adds same-site tracked push redirects for exact-product and Shop attribution, plus applied-coupon facts for Vici15 eligibility checks.

= 0.3.2 =
* Make the default disclosure explicit for US marketing SMS and advance new consent evidence to v2.

= 0.3.1 =
* Prevent theme styles from collapsing the SMS consent checkbox and provide a clear 24px control.

= 0.3.0 =
* Preserves optional SMS consent through the Essential Addons email OTP flow.
* Uses the confirmed Essential Addons phone key and syncs normalized values to billing_phone.
* Adds versioned cart lifecycle events and a durable encrypted delivery outbox.
* Replaces transient raw tokens with encrypted 256-bit URL-safe recovery tokens.
* Restores carts at current WooCommerce availability and pricing.
* Replaces unsigned attribution cookies with a short-lived server-side WooCommerce session context.
* Adds signed final-send cart preflight, replay protection, and recovery-route rate limiting.
* Makes order events idempotent and limits attribution to matching recovery-linked orders.

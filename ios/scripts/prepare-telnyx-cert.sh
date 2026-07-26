#!/usr/bin/env bash
#
# Converts Apple's VoIP Services Certificate into the two PEM blobs that the
# Telnyx portal asks for, using the private key generated alongside the CSR.
#
# Run this once the Account Holder sends back voip_services.cer:
#
#   ./scripts/prepare-telnyx-cert.sh ~/Downloads/voip_services.cer
#
# Output (written to certs/, gitignored):
#   certs/telnyx_cert.pem   → paste into the Telnyx "Certificate" field
#   certs/telnyx_key.pem    → paste into the Telnyx "Private key" field
#
set -euo pipefail

CER="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/../certs"
KEY="$CERTS_DIR/voip_push_private_key.pem"

if [[ -z "$CER" ]]; then
  echo "usage: $0 /path/to/voip_services.cer" >&2
  exit 1
fi

if [[ ! -f "$CER" ]]; then
  echo "error: certificate not found: $CER" >&2
  exit 1
fi

if [[ ! -f "$KEY" ]]; then
  echo "error: private key missing: $KEY" >&2
  echo "       It is generated with the CSR and must not be regenerated —" >&2
  echo "       a new key would not match the certificate Apple issued." >&2
  exit 1
fi

echo "==> Converting Apple .cer (DER) to PEM"
openssl x509 -inform DER -in "$CER" -out "$CERTS_DIR/telnyx_cert.pem"

echo "==> Normalising the private key to PKCS#1 PEM"
openssl rsa -in "$KEY" -out "$CERTS_DIR/telnyx_key.pem"
chmod 600 "$CERTS_DIR/telnyx_key.pem"

echo "==> Verifying the certificate and key actually match"
CERT_MOD=$(openssl x509 -noout -modulus -in "$CERTS_DIR/telnyx_cert.pem" | openssl md5)
KEY_MOD=$(openssl rsa  -noout -modulus -in "$CERTS_DIR/telnyx_key.pem"  | openssl md5)

if [[ "$CERT_MOD" != "$KEY_MOD" ]]; then
  echo "MISMATCH: this certificate was not issued from our CSR." >&2
  echo "  cert: $CERT_MOD" >&2
  echo "  key:  $KEY_MOD" >&2
  echo "Ask the Account Holder to redo Step 2 using ViciInbox_VoIP.certSigningRequest." >&2
  exit 1
fi
echo "    match confirmed"

echo
echo "==> Certificate details"
openssl x509 -in "$CERTS_DIR/telnyx_cert.pem" -noout -subject -dates \
  | sed 's/^/    /'

echo
echo "Done. Next steps in the Telnyx portal:"
echo "  1. Mission Control → API Keys → Credentials tab → Add iOS Credential"
echo "     Paste the FULL contents of each file, including the BEGIN/END lines:"
echo "       certificate : $CERTS_DIR/telnyx_cert.pem"
echo "       private key : $CERTS_DIR/telnyx_key.pem"
echo "  2. SIP Connections → the credential connection used by TELNYX_SIP_USERNAME"
echo "     → WEBRTC tab → iOS section → assign the credential you just created."
echo
echo "Reminder: note the certificate expiry above. When it lapses, incoming"
echo "calls stop ringing on the iPhone with no other symptom."

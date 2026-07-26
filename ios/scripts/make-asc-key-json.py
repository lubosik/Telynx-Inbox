#!/usr/bin/env python3
"""
Writes the App Store Connect API key JSON that fastlane's upload_to_testflight
expects, reading the key material from environment variables.

Lives in a file rather than inline in the workflow so it can be tested locally,
and so the PEM's newlines are escaped by json.dump instead of by hand.

Env:
  ASC_KEY_ID           the 10-character key id
  ASC_ISSUER_ID        the issuer UUID
  ASC_KEY_P8_BASE64    base64 of the .p8 file

Usage:  python3 make-asc-key-json.py [output_path]
"""

import base64
import binascii
import json
import os
import sys


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "asc_api_key.json"

    missing = [v for v in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8_BASE64")
               if not os.environ.get(v)]
    if missing:
        sys.exit(f"error: missing environment variable(s): {', '.join(missing)}")

    raw = os.environ["ASC_KEY_P8_BASE64"].strip()
    try:
        key = base64.b64decode(raw, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as exc:
        sys.exit(f"error: ASC_KEY_P8_BASE64 is not valid base64 of a text file ({exc}). "
                 "Generate it with: base64 -i AuthKey_XXXX.p8 | tr -d '\\n'")

    if "BEGIN PRIVATE KEY" not in key:
        sys.exit("error: decoded content is not a PEM private key — check the secret "
                 "holds the .p8 file, not the key id.")

    payload = {
        "key_id": os.environ["ASC_KEY_ID"],
        "issuer_id": os.environ["ASC_ISSUER_ID"],
        "key": key,
        "in_house": False,          # Individual/Organization account, not Enterprise
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)
    os.chmod(out_path, 0o600)

    print(f"wrote {out_path} (key_id={payload['key_id']}, {len(key.splitlines())} PEM lines)")


if __name__ == "__main__":
    main()

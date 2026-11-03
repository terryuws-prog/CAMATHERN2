#!/usr/bin/env bash
# Sets up (or updates) the HTTPS relay on a fresh Ubuntu VM:
#   git clone https://github.com/terryuws-prog/camathern2.git
#   cd camathern2/relay && bash setup.sh
# Safe to run again: keeps .env and the certificate.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

# 1. Docker and certbot
if ! command -v docker >/dev/null 2>&1; then
  echo ">> Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
if ! command -v certbot >/dev/null 2>&1; then
  echo ">> Installing certbot"
  sudo apt-get update -qq && sudo apt-get install -y -qq certbot
fi

# 2. Hostname and email (asked once, saved in .env)
if [ ! -f .env ]; then
  IP=$(curl -fs -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" || true)
  if [ -z "$IP" ]; then
    echo "Could not detect this VM's external IP." >&2
    exit 1
  fi
  ACME_EMAIL=""
  while [ -z "$ACME_EMAIL" ]; do
    read -rp "Email for certificate expiry notices: " ACME_EMAIL
  done
  cat > .env <<ENV
RELAY_DOMAIN=${IP//./-}.sslip.io
RELAY_IP=${IP}
ACME_EMAIL=${ACME_EMAIL}
ENV
fi
set -a; . ./.env; set +a

# 3. Can this server reach the API through Cloudflare? (bot protection check)
echo ">> Checking that the API on rivermonitor is reachable from here"
code=$(curl -s -o /tmp/relay-check.txt -w '%{http_code}' --max-time 20 -X POST \
  https://rivermonitor.aber.ac.uk/cam/dev/api/v1/readings -H 'Content-Type: application/json' -d '{"records":[]}' || true)
if [ "$code" = "401" ] && grep -q '"missing_api_key"' /tmp/relay-check.txt; then
  echo "   OK: the API answered (401 without a key, as expected)"
else
  echo "   WARNING: expected 401 from the API but got '$code'. First lines of the reply:"
  head -c 300 /tmp/relay-check.txt; echo
  echo "   If this is a Cloudflare challenge page, the relay will not work. Send this output to Terry."
fi

# 4. RSA certificate (Let's Encrypt; ZeroSSL if the shared sslip.io limit is hit)
issue() {
  sudo certbot certonly --standalone --non-interactive --agree-tos -m "$ACME_EMAIL" \
    --key-type rsa --rsa-key-size 2048 -d "$RELAY_DOMAIN" \
    --deploy-hook "docker exec sensor-relay-nginx nginx -s reload || true" "$@"
}
if ! sudo test -f "/etc/letsencrypt/live/${RELAY_DOMAIN}/fullchain.pem"; then
  echo ">> Getting an HTTPS certificate for ${RELAY_DOMAIN}"
  if ! issue; then
    echo ">> Let's Encrypt refused (sslip.io is shared and can hit its weekly limit). Trying ZeroSSL."
    EAB=$(curl -fsS https://api.zerossl.com/acme/eab-credentials-email --data "email=${ACME_EMAIL}")
    KID=$(printf '%s' "$EAB" | python3 -c 'import sys, json; print(json.load(sys.stdin)["eab_kid"])')
    HMAC=$(printf '%s' "$EAB" | python3 -c 'import sys, json; print(json.load(sys.stdin)["eab_hmac_key"])')
    issue --server https://acme.zerossl.com/v2/DV90 --eab-kid "$KID" --eab-hmac-key "$HMAC"
  fi
fi

# 5. Start the relay
echo ">> Starting the relay"
sudo docker compose up -d
sleep 3

# 6. End-to-end check through the relay
code=$(curl -s -o /tmp/relay-check.txt -w '%{http_code}' --max-time 20 -X POST \
  "https://${RELAY_DOMAIN}/cam/dev/api/v1/readings" -H 'Content-Type: application/json' -d '{"records":[]}' || true)
if [ "$code" = "401" ] && grep -q '"missing_api_key"' /tmp/relay-check.txt; then
  RESULT="OK (the API answered through the relay)"
else
  RESULT="NOT OK: got '$code' ($(head -c 120 /tmp/relay-check.txt))"
fi

cat <<OUT

================ Relay ================
Relay check:   ${RESULT}
Hostname:      ${RELAY_DOMAIN}
Static IP:     ${RELAY_IP}
Dev upload:    https://${RELAY_DOMAIN}/cam/dev/api/v1/readings
Prod upload:   https://${RELAY_DOMAIN}/cam/api/v1/readings
Certificate:   RSA 2048, renews automatically
=======================================
OUT

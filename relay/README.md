# HTTPS relay for the cellular nodes

The nodes' u-blox SARA-R410M modem cannot complete a TLS handshake with the
Cloudflare-fronted `rivermonitor.aber.ac.uk`. This relay runs on a small Google
Cloud VM with its own hostname (DNS-only, no Cloudflare), an RSA certificate and
older TLS 1.2 cipher suites enabled, and forwards API requests unchanged to
rivermonitor. Readings still land in the same database and appear on
`https://rivermonitor.aber.ac.uk/cam/` as usual.

```
node --HTTPS (modem-friendly)--> relay VM --HTTPS--> Cloudflare --> rivermonitor /cam/api
```

Only `/cam/api/*`, `/cam/dev/api/*` and `/cam/dev/healthz` are relayed; anything
else returns 404.

## Set up

On a fresh Ubuntu VM (static external IP, ports 80 and 443 open):

```bash
git clone https://github.com/terryuws-prog/camathern2.git
cd camathern2/relay && bash setup.sh
```

It installs Docker and certbot, asks once for an email address, checks the API is
reachable through Cloudflare from this server, gets an RSA certificate for
`<ip>.sslip.io` (Let's Encrypt, or ZeroSSL if the shared sslip.io limit is hit),
starts nginx on 443 and tests a request end to end. The certificate renews
automatically (certbot timer on port 80, then nginx reloads).

To update after a change in this folder: `git pull && bash setup.sh`.

## Addresses for the firmware

| | |
|---|---|
| Dev upload | `https://<ip>.sslip.io/cam/dev/api/v1/readings` |
| Production upload | `https://<ip>.sslip.io/cam/api/v1/readings` |

Same API keys, headers and JSON as on rivermonitor. If the modem validates
certificates, it needs the root CA of the relay certificate: ISRG Root X1
(Let's Encrypt) or USERTrust RSA (ZeroSSL).

## TLS offered

TLS 1.2 and 1.3. TLS 1.2 suites, in order: ECDHE-RSA with AES-GCM/ChaCha20,
ECDHE-RSA with AES-CBC (SHA256/SHA384/SHA1), then RSA key exchange with AES-GCM
and AES-CBC (`AES128-SHA256`, `AES256-SHA256`, `AES128-SHA`, `AES256-SHA`).
3DES is not offered. Edit `ssl_ciphers` in `nginx.conf.template` if the modem
needs something else.

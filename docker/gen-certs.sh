#!/usr/bin/env bash
#
# gen-certs.sh — Generate mTLS certificates for Connectome gRPC services.
#
# Creates a self-signed CA and per-service certificates for:
#   - connectome (server)
#   - discord-axon (server + client)
#   - signal-axon (server + client)
#   - bot-runtime (client)
#
# Output: docker/certs/
#   ca.crt, ca.key
#   <service>.crt, <service>.key  (for each service)
#
# Usage: ./docker/gen-certs.sh [--force]
#   --force: overwrite existing certs
#
set -euo pipefail

CERT_DIR="$(dirname "$0")/certs"
DAYS=3650  # 10 years
KEY_SIZE=4096

if [[ -f "$CERT_DIR/ca.crt" && "${1:-}" != "--force" ]]; then
    echo "Certificates already exist in $CERT_DIR. Use --force to regenerate."
    exit 0
fi

mkdir -p "$CERT_DIR"

echo "=== Generating CA ==="
openssl req -x509 -newkey rsa:$KEY_SIZE -nodes \
    -keyout "$CERT_DIR/ca.key" \
    -out "$CERT_DIR/ca.crt" \
    -days $DAYS \
    -subj "/CN=Connectome Internal CA/O=Connectome" \
    2>/dev/null

chmod 600 "$CERT_DIR/ca.key"

# Generate a signed cert for a service
gen_cert() {
    local name="$1"
    local cn="$2"
    local san="$3"

    echo "=== Generating cert: $name (CN=$cn, SAN=$san) ==="

    # CSR
    openssl req -newkey rsa:2048 -nodes \
        -keyout "$CERT_DIR/$name.key" \
        -out "$CERT_DIR/$name.csr" \
        -subj "/CN=$cn/O=Connectome" \
        2>/dev/null

    # Sign with CA
    openssl x509 -req \
        -in "$CERT_DIR/$name.csr" \
        -CA "$CERT_DIR/ca.crt" \
        -CAkey "$CERT_DIR/ca.key" \
        -CAcreateserial \
        -out "$CERT_DIR/$name.crt" \
        -days $DAYS \
        -extfile <(printf "subjectAltName=$san\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth") \
        2>/dev/null

    chmod 600 "$CERT_DIR/$name.key"
    rm -f "$CERT_DIR/$name.csr"
}

# Server certs (DNS names match Docker Compose service names)
gen_cert "connectome"    "connectome"    "DNS:connectome,DNS:localhost,IP:127.0.0.1"
gen_cert "discord-axon"  "discord-axon"  "DNS:discord-axon,DNS:localhost,IP:127.0.0.1"
gen_cert "signal-axon"   "signal-axon"   "DNS:signal-axon,DNS:localhost,IP:127.0.0.1"

# Client cert (shared by all bot-runtime containers)
gen_cert "bot-runtime"   "bot-runtime"   "DNS:bot-runtime,DNS:localhost,IP:127.0.0.1"

rm -f "$CERT_DIR/ca.srl"

echo ""
echo "=== Certificates generated in $CERT_DIR ==="
ls -la "$CERT_DIR"
echo ""
echo "Mount into containers via docker-compose volumes."
echo "Set GRPC_TLS=true to enable mTLS."

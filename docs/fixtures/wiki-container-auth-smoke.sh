#!/usr/bin/env bash
set -euo pipefail

# Run from a clean Wiki checkout. Requires Docker, OpenSSL, curl, Node, and the
# already-built image for this checkout (defaults to the clean d701017 image).
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
IMAGE="${SMOKE_IMAGE:-madhouse-wiki:clean-rc-d701017}"
SHA="${SMOKE_SHA:-$(git rev-parse HEAD)}"
IMAGE_SHA="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MADHOUSE_RELEASE_SHA=//p')"
if [[ "$IMAGE_SHA" != "$SHA" ]]; then
  echo "image release SHA mismatch: expected $SHA, got ${IMAGE_SHA:-missing}" >&2
  exit 1
fi

SUFFIX="$$-$(openssl rand -hex 3)"
TMP="$(mktemp -d "/tmp/wiki-container-auth-smoke.${SUFFIX}.XXXXXX")"
APP_NET="wiki-auth-internal-${SUFFIX}"
PROXY_NET="wiki-auth-proxy-${SUFFIX}"
WIKI="wiki-auth-${SUFFIX}"
CONNECTOR="connector-auth-${SUFFIX}"
STORAGE="storage-auth-${SUFFIX}"
PROXY="proxy-auth-${SUFFIX}"
WIKI_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
CONNECTOR_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
cleanup() {
  for container in "$PROXY" "$CONNECTOR" "$WIKI" "$STORAGE"; do
    docker stop "$container" >/dev/null 2>&1 || true
    docker rm "$container" >/dev/null 2>&1 || true
  done
  docker network rm "$APP_NET" "$PROXY_NET" >/dev/null 2>&1 || true
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)' "$TMP"
}
trap cleanup EXIT

mkdir -m 700 -p "$TMP/storage-data/accounts"
ACCOUNT_KEY="$(openssl rand -hex 32)"
WIKI_KEY="$(openssl rand -hex 32)"
EXECUTOR_KEY="$(openssl rand -hex 32)"
BRIDGE_KEY="$(openssl rand -hex 32)"
INITDATA_KEY="$(openssl rand -hex 32)"
STORAGE_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' \
  "ACCOUNT_SESSION_KEY=$ACCOUNT_KEY" \
  "WIKI_SESSION_KEY=$WIKI_KEY" \
  "MADHOUSE_GAME_EXECUTOR_KEY=$EXECUTOR_KEY" \
  "MADHOUSE_STORAGE_TOKEN=$STORAGE_TOKEN" \
  'MADHOUSE_STORAGE_ORIGIN=https://storage-smoke.test:9443/_madhouse-storage' \
  'WIKI_PUBLIC_ORIGIN=https://wiki.test' \
  'CONNECTOR_PUBLIC_ORIGIN=https://connect.test' \
  'MADHOUSE_AUTOMATION_GAME_ENABLED=1' \
  'MADHOUSE_BRIDGE_LAB=1' \
  "MADHOUSE_BRIDGE_IPC_KEY=$BRIDGE_KEY" \
  'MADHOUSE_BRIDGE_STATE_DIR=/tmp/bridge-state' \
  'MADHOUSE_BRIDGE_WITNESS_PATH=/tmp/bridge-witness' \
  'MADHOUSE_BRIDGE_PROVISION_WITNESS=1' \
  'TELEGRAM_BOT_TOKEN=123456789:synthetic_test_token' \
  "WIKI_INITDATA_KEY=$INITDATA_KEY" \
  "MADHOUSE_RELEASE_SHA=$SHA" \
  'NODE_EXTRA_CA_CERTS=/smoke-ca/tls.crt' > "$TMP/common.env"
chmod 600 "$TMP/common.env"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/tls.key" \
  -out "$TMP/tls.crt" -days 1 -subj '/CN=storage-smoke.test' \
  -addext 'subjectAltName=DNS:storage-smoke.test' >/dev/null 2>&1

ACCOUNT_SESSION_KEY="$ACCOUNT_KEY" WIKI_SESSION_KEY="$WIKI_KEY" TMP="$TMP" \
node --input-type=module -e '
import { createHmac, webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createWikiSessionAuthority } from "./shared/wiki-session.js";
import { createAutomationStateStore } from "./scripts/automation/state-store.mjs";
const encryptionKey=process.env.ACCOUNT_SESSION_KEY, signingKey=process.env.WIKI_SESSION_KEY;
const telegramUserId="42", playerId=2042;
const digest=createHmac("sha256",Buffer.from(encryptionKey,"hex")).update(`account:${telegramUserId}`).digest("hex");
const accountPath=`accounts/${digest}.json`;
const record={playerId,telegramUserId,revoked:false,expiresAt:Date.now()+3600000,revision:"00000000-0000-4000-8000-000000000042"};
const iv=webcrypto.getRandomValues(new Uint8Array(12));
const key=await webcrypto.subtle.importKey("raw",Buffer.from(encryptionKey,"hex"),"AES-GCM",false,["encrypt"]);
const data=await webcrypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new TextEncoder().encode(accountPath)},key,new TextEncoder().encode(JSON.stringify(record)));
const envelope={v:1,iv:Buffer.from(iv).toString("base64url"),data:Buffer.from(data).toString("base64url")};
writeFileSync(`${process.env.TMP}/storage-data/${accountPath}`,JSON.stringify(envelope),{mode:0o600});
const authority=createWikiSessionAuthority({store:{async read(path){return path===accountPath?{value:JSON.stringify(envelope)}:null;}},encryptionKey,signingKey});
writeFileSync(`${process.env.TMP}/wiki-session.txt`,(await authority.mint(accountPath,record,telegramUserId))+"\n",{mode:0o600});
const state=createAutomationStateStore({directory:`${process.env.TMP}/automation`});
state.write(playerId,{schemaVersion:1}); state.close();
'

cat > "$TMP/nginx.conf" <<'NGINX'
server { listen 8080; server_name wiki.test; location / { proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_pass http://wiki:9092; } }
server { listen 8081; server_name connect.test; location / { proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_pass http://connector:9093; } }
server { listen 9443 ssl; server_name storage-smoke.test; ssl_certificate /certs/tls.crt; ssl_certificate_key /certs/tls.key; location ^~ /_madhouse-storage/ { proxy_pass http://storage:9091/; } }
NGINX

docker network create --internal "$APP_NET" >/dev/null
docker network create "$PROXY_NET" >/dev/null
docker run -d --name "$STORAGE" --network "$APP_NET" --network-alias storage \
  -e HOST=0.0.0.0 -e PORT=9091 -e MADHOUSE_STORAGE_DIR=/data \
  -e MADHOUSE_STORAGE_TOKEN="$STORAGE_TOKEN" \
  -v "$ROOT/scripts/storage/server.mjs:/app/storage-server.mjs:ro" \
  -v "$TMP/storage-data:/data:ro" --entrypoint node "$IMAGE" /app/storage-server.mjs >/dev/null
docker run -d --name "$WIKI" --network "$APP_NET" --network-alias wiki \
  --env-file "$TMP/common.env" -e MADHOUSE_SERVICE=wiki -e PORT=9092 \
  -e MADHOUSE_AUTOMATION_STATE_DIR=/tmp/automation \
  -v "$TMP/tls.crt:/smoke-ca/tls.crt:ro" -v "$TMP/automation:/tmp/automation" \
  "$IMAGE" wiki >/dev/null
docker run -d --name "$CONNECTOR" --network "$APP_NET" --network-alias connector \
  --env-file "$TMP/common.env" -e MADHOUSE_SERVICE=connector -e PORT=9093 \
  -e MADHOUSE_GAME_EXECUTOR_ORIGIN=http://wiki:9095 \
  -v "$TMP/tls.crt:/smoke-ca/tls.crt:ro" "$IMAGE" connector >/dev/null
docker create --name "$PROXY" --network "$PROXY_NET" \
  -p "127.0.0.1:${WIKI_PORT}:8080" -p "127.0.0.1:${CONNECTOR_PORT}:8081" \
  -v "$TMP/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$TMP/tls.crt:/certs/tls.crt:ro" -v "$TMP/tls.key:/certs/tls.key:ro" nginx:alpine >/dev/null
docker network connect --alias storage-smoke.test "$APP_NET" "$PROXY"
docker start "$PROXY" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WIKI_PORT}/healthz" >/dev/null 2>&1 && \
     curl -fsS "http://127.0.0.1:${CONNECTOR_PORT}/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
SMOKE_WIKI_ORIGIN=https://wiki.test SMOKE_CONNECTOR_ORIGIN=https://connect.test \
  node scripts/deploy/smoke-vps-image.mjs \
  "http://127.0.0.1:${WIKI_PORT}" "http://127.0.0.1:${CONNECTOR_PORT}" "$SHA"

UNAUTH="$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${WIKI_PORT}/api/automation/state")"
[[ "$UNAUTH" == 401 ]] || { echo "unauthenticated state expected 401, got $UNAUTH" >&2; exit 1; }
AUTH="$(curl --max-time 10 -sS -o "$TMP/state.json" -w '%{http_code}' \
  -H "Authorization: Bearer $(cat "$TMP/wiki-session.txt")" \
  "http://127.0.0.1:${WIKI_PORT}/api/automation/state")"
[[ "$AUTH" == 200 ]] || { echo "authenticated state expected 200, got $AUTH" >&2; cat "$TMP/state.json" >&2; exit 1; }
node -e 'const x=require(process.argv[1]); if(!Number.isSafeInteger(x.serverTime)||x.recovery?.status!=="clear")process.exit(1)' "$TMP/state.json"
CSP="$(curl -fsSI "http://127.0.0.1:${CONNECTOR_PORT}/" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: //p')"
[[ "$CSP" == *'frame-ancestors https://wiki.test https://web.telegram.org'* ]] || { echo 'unexpected Connector CSP' >&2; exit 1; }
EGRESS="$(docker run --rm --network "$APP_NET" --entrypoint node "$IMAGE" \
  -e 'fetch("https://example.com",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(2)).catch(e=>{console.log(e.cause?.code||e.name)})' 2>&1 | tail -1)"
echo "published proxy ingress passed; Wiki auth 401/200; Connector CSP passed; app-network egress probe: $EGRESS"
echo 'No game routes or mutations were requested; all credentials and account data were synthetic.'

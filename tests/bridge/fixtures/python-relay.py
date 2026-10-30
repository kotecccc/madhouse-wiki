"""Run the real bridge relay against loopback-only fake endpoints."""
import base64
import hashlib
import importlib.util
import os
import socket
import ssl
import sys
import types

credentials = types.ModuleType("credential_store")
for name in ("AgentAlreadyRunning", "CredentialError"):
    setattr(credentials, name, type(name, (Exception,), {}))
for name in ("load", "replace", "running_lock", "save"):
    setattr(credentials, name, lambda *args, **kwargs: None)
sys.modules["credential_store"] = credentials
updates = types.ModuleType("auto_update")
updates.start = lambda *args, **kwargs: None
sys.modules["auto_update"] = updates
spec = importlib.util.spec_from_file_location("bridge_test_agent", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

gateway_port, game_port = map(int, sys.argv[2:4])
ws = socket.create_connection(("127.0.0.1", gateway_port))
if len(sys.argv) > 4 and sys.argv[4] == "tls":
    context = ssl.create_default_context(cafile=os.path.join(os.path.dirname(__file__), "cargo-cert.pem"))
    ws = context.wrap_socket(ws, server_hostname="cargohustle.online")
key = base64.b64encode(os.urandom(16)).decode("ascii")
ws.sendall((
    "GET /bridge/data HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    "Upgrade: websocket\r\nConnection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
    "X-Madhouse-Bridge-Stop-Ack: 1\r\n"
    "Authorization: MadhouseBridge 00000000-0000-4000-8000-000000000001."
    + "A" * 43 + "\r\n\r\n"
).encode("ascii"))
status, fields = bridge.headers(ws)
expected = base64.b64encode(hashlib.sha1((key + bridge.GUID).encode()).digest()).decode("ascii")
if not status.startswith("HTTP/1.1 101 ") or fields.get("sec-websocket-accept") != expected:
    raise RuntimeError("fake gateway handshake failed")
target = socket.create_connection(("127.0.0.1", game_port))
print("RELAY_READY", flush=True)
try:
    bridge.relay(ws, target)
finally:
    target.close()
    ws.close()

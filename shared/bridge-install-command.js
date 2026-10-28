const BOOTSTRAP_URL = "https://madhouse-wiki.ru/bridge/bootstrap.pyz";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * The expected SHA must be embedded in a trusted app release, never supplied
 * by the downloaded bootstrap or an untrusted manifest. The invitation is
 * single-use and contains no game token.
 */
export function createBridgeInstallCommand({
  invitation,
  bootstrapSha256,
} = {}) {
  if (
    typeof invitation !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(invitation) ||
    typeof bootstrapSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(bootstrapSha256)
  )
    throw new TypeError("invalid_bridge_install_parameters");
  const source = [
    "import hashlib,os,sys,tempfile,urllib.request",
    "class NoRedirect(urllib.request.HTTPRedirectHandler):",
    " def redirect_request(self,*a,**k): return None",
    `url=${JSON.stringify(BOOTSTRAP_URL)}`,
    `expected=${JSON.stringify(bootstrapSha256)}`,
    "with urllib.request.build_opener(NoRedirect()).open(url,timeout=30) as r: data=r.read(2097153)",
    "if len(data)>2097152 or hashlib.sha256(data).hexdigest()!=expected: raise SystemExit('Bootstrap verification failed')",
    "fd,path=tempfile.mkstemp(prefix='madhouse-bridge-',suffix='.pyz')",
    "with os.fdopen(fd,'wb') as f: f.write(data)",
    "os.execv(sys.executable,[sys.executable,path,'--pair'])",
  ].join("\n");
  return `if command -v apk >/dev/null 2>&1; then apk add --no-cache python3 openssl ca-certificates; else true; fi && printf '%s\\n' ${quote(invitation)} | python3 -c ${quote(source)}`;
}

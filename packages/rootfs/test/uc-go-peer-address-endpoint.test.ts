import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const configureScript = fileURLToPath(
  new URL(
    "../reference/uc-go-peer/rootfs/uc-go-peer-configure.sh",
    import.meta.url,
  ),
);
const setupServerScript = fileURLToPath(
  new URL(
    "../reference/uc-go-peer/rootfs/uc-go-peer-setup-server.py",
    import.meta.url,
  ),
);

/**
 * Render the proxy Caddyfile without running the script, which exits on its
 * required arguments. The function body ends at its heredoc terminator.
 */
async function renderProxyCaddyfile(proxyHostname: string): Promise<string> {
  const source = await readFile(configureScript, "utf8");
  const start = source.indexOf("render_proxy_caddyfile()");
  assert.notEqual(start, -1, "render_proxy_caddyfile is missing");
  const body = source.slice(start);
  const end = body.indexOf("\nEOF\n");
  assert.notEqual(end, -1, "render_proxy_caddyfile heredoc is unterminated");
  const fn = `${body.slice(0, end + "\nEOF\n".length)}}\n`;

  const { stdout } = await execFileAsync("bash", [
    "-c",
    `${fn}\nWS_BACKEND_PORT=9096 render_proxy_caddyfile "${proxyHostname}"`,
  ]);
  return stdout;
}

test("uc-go-peer exposes its address document through the HTTPS proxy", async () => {
  const caddyfile = await renderProxyCaddyfile("relay.example.test");

  // A PWA on an HTTPS page cannot reach the mapped plain-HTTP port, so these
  // have to be served by the proxy or the card cannot read them at all.
  assert.match(caddyfile, /handle \/multiaddrs \{\s*reverse_proxy http:\/\/127\.0\.0\.1:80/);
  assert.match(caddyfile, /handle \/describe \{\s*reverse_proxy http:\/\/127\.0\.0\.1:80/);
  assert.match(caddyfile, /handle \/health \{\s*reverse_proxy http:\/\/127\.0\.0\.1:80/);
});

test("uc-go-peer routes the address handles before the WebSocket catch-all", async () => {
  const caddyfile = await renderProxyCaddyfile("relay.example.test");

  // Caddy takes the first matching handle. Behind the bare `handle` the named
  // ones never run, and /multiaddrs would land in the libp2p WebSocket backend.
  const catchAll = caddyfile.indexOf("handle {");
  assert.notEqual(catchAll, -1, "the WebSocket catch-all is missing");
  for (const path of ["/describe", "/multiaddrs", "/health"]) {
    const named = caddyfile.indexOf(`handle ${path} {`);
    assert.notEqual(named, -1, `handle ${path} is missing`);
    assert.ok(
      named < catchAll,
      `handle ${path} must precede the catch-all, otherwise it never matches`,
    );
  }
});

test("uc-go-peer serves the address document under the shared path names", async () => {
  const source = await readFile(setupServerScript, "utf8");

  // orbitdb-relay already answers /multiaddrs, so a consumer looks for one path
  // on every profile rather than branching per profile.
  assert.match(source, /"\/describe", "\/multiaddrs"/);
  assert.match(source, /def _handle_describe/);
});

test("uc-go-peer unwraps the readiness envelope from the address document", async () => {
  const source = await readFile(setupServerScript, "utf8");
  const start = source.indexOf("def _handle_describe");
  const body = source.slice(start, start + 900);

  // /metadata answers {"status": ..., "metadata": {...}}. A consumer asking for
  // the address document wants the document, not the wrapper around it.
  assert.match(body, /payload\.get\("metadata"\)/);
  assert.match(body, /document\["profile"\] = "uc-go-peer"/);
});

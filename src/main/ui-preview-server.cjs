const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const guard = fs.readFileSync(path.join(__dirname, '../renderer/ui-preview-guard.js'), 'utf8');
const csp = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
function attachUiNavigationGuard(contents, previews) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return;
    let allowed = false;
    try {
      const url = new URL(event.url);
      for (const { server, catalog } of previews()) {
        if (new URL(server.url).origin !== url.origin) continue;
        // Ordinary internal links do not carry Acorn's selection parameter.
        allowed = !/\/(api|graphql|trpc)(\/|$)/i.test(url.pathname);
      }
    } catch { /* Reject unknown navigation targets. */ }
    if (!allowed) { event.preventDefault(); contents.send('preview:blocked'); }
  });
}
function inject(html, config) {
  const bootstrap = `<script>window.__ACORN_UI_PREVIEW__=${JSON.stringify(config).replace(/</g, '\\u003c')};\n${guard}</script>`;
  // Insert before any project scripts, including scripts outside the head.
  return html.replace(/^(\s*<!doctype[^>]*>)?/i, (_match, doctype = '') => doctype + bootstrap);
}
function allowedRequest(method, destination, pathname, pages) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (destination === 'empty' || ['serviceworker', 'worker', 'sharedworker', 'object', 'embed'].includes(destination)) return false;
  if (/\/(api|graphql|trpc)(\/|$)/i.test(pathname)) return false;
  if (['script', 'style', 'image', 'font', 'audio', 'video', 'track', 'manifest'].includes(destination)) return true;
  return ['document', 'iframe', 'frame'].includes(destination);
}
async function startUiPreview(upstreamUrl, catalog) {
  const upstream = new URL(upstreamUrl);
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    const selected = catalog.pages.find(page => page.id === url.searchParams.get('__acorn_page'))
      || catalog.pages.find(page => new URL(page.previewPath || page.path, upstream.origin).pathname === url.pathname);
    const config = { ...(selected ? { adapter: selected.adapter, screen: selected.screen } : {}), responses: catalog.responses || {}, dataBridge: Boolean(catalog.dataBridge), visual: Boolean(catalog.visual) };
    url.searchParams.delete('__acorn_page');
    const destination = request.headers['sec-fetch-dest'] || 'document';
    if (!allowedRequest(request.method, destination, url.pathname, catalog.pages)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('This action is unavailable in UI preview.'); return;
    }
    const target = new URL(url.pathname + url.search, upstream.origin);
    try {
      const fetched = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { accept: request.headers.accept || '*/*' } });
      if (fetched.status >= 300 && fetched.status < 400) {
        response.writeHead(409, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
        response.end('<!doctype html><title>Preview setup needed</title><p>This page redirects before rendering. Configure a UI-only preview entry in .acorn/pages.json.</p>'); return;
      }
      const type = fetched.headers.get('content-type') || 'application/octet-stream';
      response.writeHead(fetched.status, { 'Content-Type': type, 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') { response.end(); return; }
      response.end(type.includes('text/html') ? inject(await fetched.text(), config) : Buffer.from(await fetched.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end('The preview server is unavailable. Refresh this preview to retry.');
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${upstream.pathname}`, updateCatalog: next => { catalog = next; }, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { startUiPreview, allowedRequest, inject, attachUiNavigationGuard };

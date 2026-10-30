// Servidor local do Studio: arquivos estáticos (os módulos ES não carregam via file://) e um
// proxy para as integrações (o navegador não define User-Agent e muitas APIs bloqueiam CORS).
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 5180);
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const MAX_BODY = 25 * 1024 * 1024;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('pedido grande demais');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Só a própria página do Studio pode usar o proxy: o cabeçalho próprio força o navegador a
// pedir permissão (preflight) a qualquer outro site, e aqui nenhuma é concedida.
async function proxy(req, res) {
  const host = `http://${req.headers.host}`;
  if (req.headers['x-planograma-proxy'] !== '1' || !origins.has(host) || (req.headers.origin && !origins.has(req.headers.origin))) {
    return sendJson(res, 403, { error: 'origem não autorizada' });
  }
  let target;
  try {
    const { url, headers } = JSON.parse(await readBody(req, 64 * 1024));
    target = new URL(url);
    if (target.protocol !== 'https:') return sendJson(res, 400, { error: 'só endereços https:// são aceitos' });
    const upstream = await fetch(target, {
      headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([, v]) => typeof v === 'string' && v !== '')),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = await upstream.text();
    if (body.length > MAX_BODY) return sendJson(res, 502, { error: 'resposta da API grande demais (mais de 25 MB)' });
    return sendJson(res, 200, { status: upstream.status, contentType: upstream.headers.get('content-type') ?? '', body });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'a API não respondeu em 20 s' : err.cause?.code ?? err.message;
    return sendJson(res, 502, { error: `não foi possível falar com ${target?.host ?? 'a API'}: ${reason}` });
  }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path === '/api/proxy' && req.method === 'POST') return proxy(req, res);
  if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'não encontrado' });
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('Não encontrado');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Construtor de Planogramas em http://localhost:${port}`));

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkPublicKey,
  createClient,
  dataUrlToBlob,
  blobToDataUrl,
  fingerprintOf,
  keyKind,
  objectName,
  parseProjectUrl,
  planSync,
  syncImages,
  syncWorkspace,
  workspaceOf,
} from '../src/cloud.js';

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
const ANON = jwt({ role: 'anon', ref: 'abcd' });
const URL_ = 'https://abcd.supabase.co';
const ORG = '11111111-1111-4111-8111-111111111111';

const reply = (status, body) =>
  new Response(body === undefined ? null : body instanceof Blob ? body : JSON.stringify(body), { status });

// Supabase de mentira: registra os pedidos e responde pelas rotas dadas.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const { pathname, search } = new URL(url);
    const call = { method: init.method, path: pathname, search, headers: init.headers, body: init.body };
    calls.push(call);
    for (const [pattern, handler] of routes) if (`${init.method} ${pathname}`.match(pattern)) return handler(call, calls);
    return reply(404, { message: 'rota não simulada' });
  };
  fn.calls = calls;
  return fn;
}

const login = (overrides = {}) => ({
  access_token: 'a1',
  refresh_token: 'r1',
  expires_in: 3600,
  user: { id: 'u1', email: 'ada@exemplo.com' },
  ...overrides,
});

test('aceita só a chave pública e endereço https', () => {
  assert.equal(keyKind(ANON), 'public');
  assert.equal(keyKind('sb_publishable_abc'), 'public');
  assert.equal(keyKind(jwt({ role: 'service_role' })), 'secret');
  assert.equal(keyKind('sb_secret_abc'), 'secret');
  assert.throws(() => checkPublicKey('sb_secret_abc'), /chave secreta/);
  assert.throws(() => checkPublicKey('qualquer'), /não reconhecida/);
  assert.equal(parseProjectUrl(' https://abcd.supabase.co/rest/v1/ '), URL_);
  assert.throws(() => parseProjectUrl('http://abcd.supabase.co'), /https/);
  assert.equal(parseProjectUrl('http://localhost:54321'), 'http://localhost:54321');
});

test('só o trabalho entra na comparação; aba e zoom não', () => {
  const state = { products: [{ sku: 'A' }], stores: [], fixture: {}, rules: {}, category: 'X', tab: 'products', zoom: 1, published: null };
  const a = fingerprintOf(workspaceOf(state));
  assert.equal(fingerprintOf(workspaceOf({ ...state, tab: 'stores', zoom: 2, selectedId: 'p1' })), a);
  assert.notEqual(fingerprintOf(workspaceOf({ ...state, category: 'Y' })), a);
});

test('decide enviar, baixar ou perguntar', () => {
  const synced = { revision: 3, fingerprint: 'f' };
  assert.equal(planSync({ fingerprint: 'f', synced, cloudRevision: 3 }), 'none');
  assert.equal(planSync({ fingerprint: 'g', synced, cloudRevision: 3 }), 'push');
  assert.equal(planSync({ fingerprint: 'f', synced, cloudRevision: 4 }), 'pull');
  assert.equal(planSync({ fingerprint: 'g', synced, cloudRevision: 4 }), 'conflict');
  // primeiro contato: empresa vazia recebe o projeto; com conteúdo, a pessoa escolhe
  assert.equal(planSync({ fingerprint: 'g', synced: null, cloudRevision: 0 }), 'push');
  assert.equal(planSync({ fingerprint: 'g', synced: null, cloudRevision: 2 }), 'conflict');
});

test('login guarda a sessão e manda o token nos pedidos', async () => {
  const fetch = fakeFetch([
    [/POST \/auth\/v1\/token/, () => reply(200, login())],
    [/POST \/rest\/v1\/rpc\/create_organization/, () => reply(200, ORG)],
  ]);
  const sessions = [];
  const client = createClient({ url: URL_, key: ANON, fetch, onSession: (s) => sessions.push(s), now: () => 1_000_000 });
  await client.signIn(' ada@exemplo.com ', 'segredo');
  assert.equal(sessions[0].user.id, 'u1');
  assert.equal(sessions[0].expires_at, 1000 + 3600);
  assert.equal(await client.rpc('create_organization', { p_name: 'X' }), ORG);
  const rpc = fetch.calls[1];
  assert.equal(rpc.headers.Authorization, 'Bearer a1');
  assert.equal(rpc.headers.apikey, ANON);
  assert.equal(JSON.parse(fetch.calls[0].body).email, 'ada@exemplo.com');
});

test('erros de login viram mensagens claras', async () => {
  const fetch = fakeFetch([[/POST \/auth\/v1\/token/, () => reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })]]);
  const client = createClient({ url: URL_, key: ANON, fetch });
  await assert.rejects(client.signIn('a@b.c', 'x'), /E-mail ou senha incorretos/);
  const offline = createClient({ url: URL_, key: ANON, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.signIn('a@b.c', 'x'), (err) => err.code === 'offline');
});

test('token vencido é renovado antes do pedido', async () => {
  let t = 0;
  const fetch = fakeFetch([
    [/POST \/auth\/v1\/token/, (call) => (call.search.includes('refresh_token') ? reply(200, login({ access_token: 'a2', refresh_token: 'r2' })) : reply(200, login()))],
    [/GET \/rest\/v1\/workspaces/, () => reply(200, [{ revision: 1 }])],
  ]);
  const client = createClient({ url: URL_, key: ANON, fetch, now: () => t });
  await client.signIn('a@b.c', 'x');
  t = 3600 * 1000; // passou uma hora
  await client.select('workspaces', 'select=revision');
  assert.deepEqual(fetch.calls.map((c) => `${c.method} ${c.path}${c.search}`), [
    'POST /auth/v1/token?grant_type=password',
    'POST /auth/v1/token?grant_type=refresh_token',
    'GET /rest/v1/workspaces?select=revision',
  ]);
  assert.equal(fetch.calls[2].headers.Authorization, 'Bearer a2');
});

test('401 renova e repete uma vez; renovação recusada desloga, queda de rede não', async () => {
  let refreshStatus = 200;
  const fetch = fakeFetch([
    [/POST \/auth\/v1\/token/, () => (refreshStatus === 200 ? reply(200, login({ access_token: 'a2' })) : reply(refreshStatus, { error_code: 'refresh_token_not_found' }))],
    [/GET \/rest\/v1\/products/, (call) => (call.headers.Authorization === 'Bearer a2' ? reply(200, []) : reply(401, { message: 'JWT expired' }))],
  ]);
  const sessions = [];
  const session = { ...login(), expires_at: 10 ** 10 };
  const client = createClient({ url: URL_, key: ANON, fetch, session, onSession: (s) => sessions.push(s) });
  assert.deepEqual(await client.select('products'), []);
  assert.equal(sessions.at(-1).access_token, 'a2');

  const stale = createClient({ url: URL_, key: ANON, fetch, session, onSession: (s) => sessions.push(s) });
  refreshStatus = 503;
  await assert.rejects(stale.select('products'));
  assert.notEqual(stale.session, null);
  refreshStatus = 400;
  await assert.rejects(stale.select('products'), (err) => err.code === 'signed_out');
  assert.equal(stale.session, null);
  assert.equal(sessions.at(-1), null);
});

test('conferir o projeto antes de guardar a configuração', async () => {
  const ok = createClient({ url: URL_, key: ANON, fetch: fakeFetch([[/GET \/auth\/v1\/settings/, () => reply(200, { disable_signup: true })]]) });
  assert.deepEqual(await ok.check(), { signupOpen: false });
  const refused = createClient({ url: URL_, key: ANON, fetch: fakeFetch([[/GET \/auth\/v1\/settings/, () => reply(401, { message: 'Invalid API key' })]]) });
  await assert.rejects(refused.check(), (err) => err.code === 'invalid_key');
  const wrong = createClient({ url: URL_, key: ANON, fetch: fakeFetch([]) });
  await assert.rejects(wrong.check(), (err) => err.code === 'invalid_url');
});

test('banco sem migração avisa o que fazer', async () => {
  const fetch = fakeFetch([[/rpc/, () => reply(404, { code: 'PGRST202', message: 'Could not find the function' })]]);
  const client = createClient({ url: URL_, key: ANON, fetch, session: { ...login(), expires_at: 10 ** 10 } });
  await assert.rejects(client.rpc('load_workspace', {}), (err) => err.code === 'not_migrated' && /supabase\/migrations/.test(err.message));
});

function cloudProject({ revision = 0 } = {}) {
  const cloud = { revision, saved: null };
  const fetch = fakeFetch([
    [/GET \/rest\/v1\/workspaces/, () => reply(200, [{ revision: cloud.revision, updated_at: '2026-10-31T12:00:00Z' }])],
    [/POST \/rest\/v1\/rpc\/save_workspace/, (call) => {
      const args = JSON.parse(call.body);
      if (args.p_expected_revision !== cloud.revision) return reply(409, { code: 'PT409', message: 'revision_conflict', details: String(cloud.revision) });
      cloud.saved = args;
      return reply(200, ++cloud.revision);
    }],
    [/POST \/rest\/v1\/rpc\/load_workspace/, () => reply(200, { revision: cloud.revision, data: { category: 'Nuvem' }, stores: [], products: [], publication: null })],
  ]);
  return { cloud, client: createClient({ url: URL_, key: ANON, fetch, session: { ...login(), expires_at: 10 ** 10 } }) };
}

const workspace = (category = 'Biscoitos') =>
  workspaceOf({ category, products: [{ sku: 'A' }, { sku: 'B' }], stores: [{ id: 'L01' }], published: null });

test('envia o projeto e guarda a revisão nova', async () => {
  const { cloud, client } = cloudProject();
  const out = await syncWorkspace(client, ORG, { workspace: workspace(), synced: null });
  assert.equal(out.action, 'pushed');
  assert.deepEqual(out.synced, { revision: 1, fingerprint: fingerprintOf(workspace()) });
  assert.equal(cloud.saved.p_org, ORG);
  assert.deepEqual(cloud.saved.p_products.map((p) => p.sku), ['A', 'B']);
  // sem mudanças dos dois lados, não faz nada
  assert.equal((await syncWorkspace(client, ORG, { workspace: workspace(), synced: out.synced })).action, 'none');
});

test('baixa quando só a nuvem mudou e pergunta quando os dois mudaram', async () => {
  const { cloud, client } = cloudProject({ revision: 5 });
  const synced = { revision: 4, fingerprint: fingerprintOf(workspace()) };
  const pulled = await syncWorkspace(client, ORG, { workspace: workspace(), synced });
  assert.equal(pulled.action, 'pulled');
  assert.equal(pulled.remote.data.category, 'Nuvem');
  assert.equal((await syncWorkspace(client, ORG, { workspace: workspace('Outra'), synced })).action, 'conflict');
  // a pessoa escolhe ficar com a sua: grava por cima da revisão atual da nuvem
  const forced = await syncWorkspace(client, ORG, { workspace: workspace('Outra'), synced, resolve: 'push' });
  assert.equal(forced.action, 'pushed');
  assert.equal(cloud.revision, 6);
});

test('gravação que perde a corrida volta como conflito, sem erro', async () => {
  const { cloud, client } = cloudProject({ revision: 2 });
  const synced = { revision: 2, fingerprint: 'antigo' };
  const realRevision = cloud.revision;
  // outra pessoa grava entre a leitura da revisão e a gravação
  const original = client.rpc;
  client.rpc = async (name, args) => {
    if (name === 'save_workspace') cloud.revision = realRevision + 1;
    return original(name, args);
  };
  assert.equal((await syncWorkspace(client, ORG, { workspace: workspace(), synced })).action, 'conflict');
});

test('SKU repetido não sobe', async () => {
  const { client } = cloudProject();
  const ws = workspaceOf({ products: [{ sku: 'A' }, { sku: 'A' }], stores: [] });
  await assert.rejects(syncWorkspace(client, ORG, { workspace: ws, synced: null }), /SKU repetido no cadastro: A/);
});

test('imagens: envia as novas, baixa as que faltam, lembra o que já subiu', async () => {
  const stored = new Map([[`/storage/v1/object/authenticated/product-images/${ORG}/B-2`, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })]]);
  const fetch = fakeFetch([
    [/POST \/storage\/v1\/object\/product-images/, (call) => {
      stored.set(call.path.replace('/object/', '/object/authenticated/'), call.body);
      return reply(200, { Key: call.path });
    }],
    [/GET \/storage\/v1\/object\/authenticated/, (call) => (stored.has(call.path) ? reply(200, stored.get(call.path)) : reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }))],
  ]);
  const client = createClient({ url: URL_, key: ANON, fetch, session: { ...login(), expires_at: 10 ** 10 } });
  const images = { 'A-1': { url: 'data:image/webp;base64,AQID', w: 1, h: 1 } };
  const out = await syncImages(client, ORG, { keys: ['A-1', 'B-2', 'C-3', 'A-1'], images, known: [] });
  assert.equal(out.uploaded, 1);
  assert.deepEqual(Object.keys(out.added), ['B-2']);
  assert.equal(out.added['B-2'].url, 'data:image/webp;base64,AQID');
  assert.deepEqual(out.missing, ['C-3']);
  assert.deepEqual(out.known.sort(), ['A-1', 'B-2']);
  const uploads = fetch.calls.filter((c) => c.method === 'POST').length;
  await syncImages(client, ORG, { keys: ['A-1'], images, known: out.known });
  assert.equal(fetch.calls.filter((c) => c.method === 'POST').length, uploads);
});

test('nome do arquivo na nuvem é seguro e a imagem volta igual', async () => {
  assert.equal(objectName(ORG, 'SKU 1/x-abc'), `${ORG}/SKU_1_x-abc`);
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(await blobToDataUrl(dataUrlToBlob(url)), url);
});

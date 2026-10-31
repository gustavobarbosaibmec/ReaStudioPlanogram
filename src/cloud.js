// Nuvem (Supabase) pelas APIs REST de Auth, banco e Storage, sem SDK: o Studio e o app
// continuam sem etapa de build e funcionando offline. Validação e plano de sincronização
// são puros; a rede entra só pelo fetch recebido em createClient.

import { contentHash } from './catalog.js';

// Partes do estado do Studio que são trabalho (vão para a nuvem). O resto é a tela
// deste computador: aba, zoom, seleção.
export const WORKSPACE_FIELDS = ['fixture', 'rules', 'category', 'storeId', 'planogram', 'edited', 'stale', 'reviews'];
export const IMAGE_BUCKET = 'product-images';
export const ROLES = { admin: 'Administrador', office: 'Escritório', promoter: 'Promotor' };

export class CloudError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseProjectUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new CloudError('Endereço do projeto inválido. Exemplo: https://abcdefgh.supabase.co', { code: 'invalid_url' });
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new CloudError('O endereço do projeto precisa começar com https://', { code: 'invalid_url' });
  return url.origin;
}

function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

export function keyKind(raw) {
  const key = String(raw ?? '').trim();
  if (key.startsWith('sb_publishable_')) return 'public';
  if (key.startsWith('sb_secret_')) return 'secret';
  const role = jwtRole(key);
  if (role === 'anon') return 'public';
  if (role === 'service_role') return 'secret';
  return 'unknown';
}

// A chave secreta ignora todas as regras de acesso: nunca pode ficar no navegador.
export function checkPublicKey(raw) {
  const kind = keyKind(raw);
  if (kind === 'secret')
    throw new CloudError('Essa é a chave secreta (service_role). Ela dá acesso total ao banco e não pode ficar no navegador: use a chave pública (anon ou publishable).', { code: 'secret_key' });
  if (kind !== 'public')
    throw new CloudError('Chave não reconhecida. Copie a chave pública (anon ou publishable) em Project Settings › API Keys.', { code: 'invalid_key' });
  return String(raw).trim();
}

// ---------- o que sobe e quando ----------

export function workspaceOf(state) {
  const data = Object.fromEntries(WORKSPACE_FIELDS.map((k) => [k, state[k] ?? null]));
  return { data, stores: state.stores, products: state.products, publication: state.published ?? null };
}

export const fingerprintOf = (workspace) => contentHash(JSON.stringify(workspace));

export function duplicates(list, key) {
  const seen = new Set();
  const dup = new Set();
  for (const item of list) (seen.has(item[key]) ? dup : seen).add(item[key]);
  return [...dup];
}

// synced: { revision, fingerprint } da última troca com a nuvem; null se este
// computador nunca sincronizou com esta empresa.
export function planSync({ fingerprint, synced, cloudRevision }) {
  if (!synced) return cloudRevision === 0 ? 'push' : 'conflict';
  const dirty = fingerprint !== synced.fingerprint;
  const changed = cloudRevision !== synced.revision;
  if (dirty && changed) return 'conflict';
  if (dirty) return 'push';
  if (changed) return 'pull';
  return 'none';
}

export const objectName = (org, imageKey) => `${org}/${imageKey.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new CloudError('Imagem em formato inesperado.');
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] });
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// ---------- cliente ----------

function friendly(status, body) {
  const code = String(body?.error_code ?? body?.code ?? body?.error ?? '');
  const text = String(body?.msg ?? body?.message ?? body?.error_description ?? '');
  if (code === 'invalid_credentials' || code === 'invalid_grant') return { code: 'invalid_credentials', text: 'E-mail ou senha incorretos.' };
  if (code === 'email_not_confirmed') return { code, text: 'Confirme o e-mail (link enviado para a caixa de entrada) antes de entrar.' };
  if (code === 'user_already_exists' || code === 'email_exists') return { code, text: 'Já existe conta com esse e-mail. Use “Entrar”.' };
  if (code === 'signup_disabled') return { code, text: 'O projeto não aceita novas contas. Peça ao administrador para criar a sua.' };
  if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883')
    return { code: 'not_migrated', text: 'O banco ainda não tem as tabelas do Planograma. Rode o arquivo supabase/migrations no SQL Editor do projeto.' };
  if (code === 'PT409' && text === 'revision_conflict') return { code: 'conflict', text: 'Outra pessoa gravou o projeto antes.' };
  return { code, text: text || `A nuvem respondeu com erro ${status}.` };
}

const sessionFrom = (res, now) => ({
  access_token: res.access_token,
  refresh_token: res.refresh_token,
  expires_at: res.expires_at ?? Math.floor(now() / 1000) + (res.expires_in ?? 3600),
  user: { id: res.user?.id, email: res.user?.email ?? '' },
});

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function createClient({ url, key, session = null, onSession = () => {}, fetch: doFetch = (...a) => globalThis.fetch(...a), now = () => Date.now() }) {
  const base = parseProjectUrl(url);
  const apikey = checkPublicKey(key);
  let current = session;
  let refreshing = null;

  const setSession = (s) => {
    current = s;
    onSession(s);
  };

  async function send(path, { method = 'GET', body, headers = {}, token = null } = {}) {
    const h = { apikey, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = body;
    if (body !== undefined && !(body instanceof Blob)) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    try {
      return await doFetch(`${base}${path}`, { method, headers: h, body: payload });
    } catch {
      throw new CloudError('Sem conexão com a nuvem. As alterações ficam guardadas aqui e sobem quando a internet voltar.', { code: 'offline' });
    }
  }

  async function fail(res) {
    const body = await res.json().catch(() => null);
    const { code, text } = friendly(res.status, body);
    const err = new CloudError(text, { status: res.status, code });
    err.detail = body?.details ?? '';
    return err;
  }

  async function refresh() {
    refreshing ??= (async () => {
      try {
        const res = await send('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: current?.refresh_token } });
        if (!res.ok) {
          const err = await fail(res);
          // só um "não" do servidor encerra a sessão; queda de rede não desloga ninguém
          if (res.status >= 400 && res.status < 500) {
            setSession(null);
            throw new CloudError('Sessão expirada. Entre de novo.', { status: 401, code: 'signed_out' });
          }
          throw err;
        }
        setSession(sessionFrom(await res.json(), now));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function token() {
    if (!current) throw new CloudError('Entre com seu e-mail e senha.', { status: 401, code: 'signed_out' });
    if (current.expires_at * 1000 - now() < 60_000) await refresh();
    return current.access_token;
  }

  // Pedido autenticado: renova o token vencido e tenta de novo uma vez.
  async function authed(path, options = {}) {
    let res = await send(path, { ...options, token: await token() });
    if (res.status === 401) {
      await refresh();
      res = await send(path, { ...options, token: current.access_token });
    }
    return res;
  }

  async function json(path, options) {
    const res = await authed(path, options);
    if (!res.ok) throw await fail(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    get session() {
      return current;
    },
    get user() {
      return current?.user ?? null;
    },

    // Confere endereço e chave antes de guardar a configuração.
    async check() {
      const res = await send('/auth/v1/settings');
      if (res.status === 401 || res.status === 403) throw new CloudError('O projeto recusou a chave. Confira a chave pública copiada.', { status: res.status, code: 'invalid_key' });
      if (!res.ok) throw new CloudError(`O endereço não respondeu como um projeto Supabase (erro ${res.status}).`, { status: res.status, code: 'invalid_url' });
      const settings = await res.json().catch(() => ({}));
      return { signupOpen: settings.disable_signup !== true };
    },

    async signIn(email, password) {
      const res = await send('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
      if (!res.ok) throw await fail(res);
      setSession(sessionFrom(await res.json(), now));
      return current.user;
    },

    // Com confirmação de e-mail ligada no projeto, a conta nasce sem sessão.
    async signUp(email, password) {
      const res = await send('/auth/v1/signup', { method: 'POST', body: { email: email.trim(), password } });
      if (!res.ok) throw await fail(res);
      const out = await res.json();
      if (out.access_token) {
        setSession(sessionFrom(out, now));
        return { signedIn: true };
      }
      return { signedIn: false };
    },

    async signOut() {
      if (current) await send('/auth/v1/logout', { method: 'POST', token: current.access_token }).catch(() => {});
      setSession(null);
    },

    rpc: (name, args = {}) => json(`/rest/v1/rpc/${name}`, { method: 'POST', body: args }),
    select: (table, query = '') => json(`/rest/v1/${table}?${query}`),

    async upload(path, blob) {
      const res = await authed(`/storage/v1/object/${IMAGE_BUCKET}/${encodePath(path)}`, {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': blob.type, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
      });
      if (!res.ok) throw await fail(res);
    },

    // null quando o arquivo não existe na nuvem
    async download(path) {
      const res = await authed(`/storage/v1/object/authenticated/${IMAGE_BUCKET}/${encodePath(path)}`);
      if (res.ok) return res.blob();
      const err = await fail(res);
      if (res.status === 404 || err.code === 'not_found' || err.code === 'NoSuchKey') return null;
      throw err;
    },
  };
}

// ---------- operações do Studio ----------

export async function myOrganizations(client) {
  const rows = await client.select('memberships', `select=org_id,role,display_name,organizations(name)&user_id=eq.${client.user.id}`);
  return rows.map((r) => ({ id: r.org_id, name: r.organizations?.name ?? '', role: r.role })).sort((a, b) => a.name.localeCompare(b.name));
}

export const listMembers = (client, org) =>
  client.select('memberships', `select=user_id,role,display_name&org_id=eq.${org}&order=display_name`);

// Decide e executa a troca do projeto com a nuvem.
// resolve: 'push' | 'pull' quando a pessoa já escolheu num conflito.
// Devolve { action: 'none' | 'pushed' | 'pulled' | 'conflict', synced?, remote?, cloud? }.
export async function syncWorkspace(client, org, { workspace, synced, resolve = null }) {
  const [cloud = { revision: 0, updated_at: null }] = await client.select('workspaces', `select=revision,updated_at&org_id=eq.${org}`);
  const fingerprint = fingerprintOf(workspace);
  const action = resolve ?? planSync({ fingerprint, synced, cloudRevision: cloud.revision });
  if (action === 'none' || action === 'conflict') return { action, cloud };
  if (action === 'pull') return { action: 'pulled', remote: await client.rpc('load_workspace', { p_org: org }), cloud };

  const skus = duplicates(workspace.products, 'sku');
  if (skus.length) throw new CloudError(`SKU repetido no cadastro: ${skus.slice(0, 5).join(', ')}. Corrija antes de enviar.`, { code: 'duplicate_sku' });
  const ids = duplicates(workspace.stores, 'id');
  if (ids.length) throw new CloudError(`Código de loja repetido: ${ids.slice(0, 5).join(', ')}. Corrija antes de enviar.`, { code: 'duplicate_store' });
  try {
    const revision = await client.rpc('save_workspace', {
      p_org: org,
      p_expected_revision: resolve === 'push' ? cloud.revision : (synced?.revision ?? 0),
      p_data: workspace.data,
      p_stores: workspace.stores,
      p_products: workspace.products,
      p_publication: workspace.publication,
    });
    return { action: 'pushed', synced: { revision: Number(revision), fingerprint }, cloud };
  } catch (err) {
    if (err.code === 'conflict') return { action: 'conflict', cloud };
    throw err;
  }
}

async function eachLimited(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Envia as imagens usadas que a nuvem ainda não tem e baixa as que faltam aqui.
// known: chaves que já se sabe estarem na nuvem (evita listar o Storage a cada vez).
export async function syncImages(client, org, { keys, images, known, toImage = async (blob) => ({ url: await blobToDataUrl(blob), w: 0, h: 0 }) }) {
  const done = new Set(known);
  const added = {};
  const failed = [];
  let uploaded = 0;
  const missing = [];
  await eachLimited([...new Set(keys)], 4, async (k) => {
    try {
      if (images[k]) {
        if (done.has(k)) return;
        await client.upload(objectName(org, k), dataUrlToBlob(images[k].url));
        uploaded++;
        done.add(k);
      } else {
        const blob = await client.download(objectName(org, k));
        if (!blob) return void missing.push(k);
        added[k] = await toImage(blob);
        done.add(k);
      }
    } catch (err) {
      if (err.code === 'offline' || err.code === 'signed_out') throw err;
      failed.push({ key: k, text: err.message });
    }
  });
  return { known: [...done], added, uploaded, downloaded: Object.keys(added).length, missing, failed };
}

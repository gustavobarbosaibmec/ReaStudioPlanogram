// Conexões com outras plataformas (chave de API). Os modelos e o mapeamento de respostas
// são puros; a chamada passa pelo proxy do servidor local (CORS e User-Agent).

import { parseSalesRecords } from './sales.js';

const field = (key, label, extra = {}) => ({ key, label, ...extra });

export const CONNECTOR_TYPES = {
  cosmos: {
    label: 'Cosmos (Bluesoft)',
    purpose: 'Completa descrição, marca e medidas dos produtos pelo EAN.',
    docs: 'https://cosmos.bluesoft.com.br/api',
    fields: [
      field('token', 'Token (X-Cosmos-Token)', { secret: true }),
      field('userAgent', 'User-Agent informado pela Bluesoft', { default: 'Cosmos-API-Request' }),
      field('baseUrl', 'Endereço da API', { default: 'https://api.cosmos.bluesoft.com.br' }),
    ],
  },
  sales: {
    label: 'Base de vendas (API REST/JSON)',
    purpose: 'Puxa o sell-out por loja e período para a comparação antes × depois da virada.',
    fields: [
      field('baseUrl', 'Endereço da API', { placeholder: 'https://erp.suaempresa.com.br/api' }),
      field('path', 'Caminho da consulta', { default: '/vendas?loja={loja}&inicio={inicio}&fim={fim}' }),
      field('authHeader', 'Cabeçalho de autenticação', { default: 'Authorization' }),
      field('authValue', 'Valor do cabeçalho', { default: 'Bearer {chave}' }),
      field('key', 'Chave da API', { secret: true }),
      field('listPath', 'Lista no JSON (ex.: data.itens; vazio = raiz)', { default: '' }),
      field('dateField', 'Campo da data', { default: 'data' }),
      field('eanField', 'Campo do EAN', { default: 'ean' }),
      field('skuField', 'Campo do SKU (opcional)', { default: '' }),
      field('unitsField', 'Campo da quantidade', { default: 'quantidade' }),
      field('revenueField', 'Campo do valor (opcional)', { default: 'valor' }),
    ],
  },
  custom: {
    label: 'Outra plataforma',
    purpose: 'Guarda a chave de uma API para uso futuro (teste com um caminho qualquer).',
    fields: [
      field('baseUrl', 'Endereço da API', { placeholder: 'https://api.exemplo.com' }),
      field('path', 'Caminho de teste', { default: '/' }),
      field('authHeader', 'Cabeçalho de autenticação', { default: 'Authorization' }),
      field('authValue', 'Valor do cabeçalho', { default: 'Bearer {chave}' }),
      field('key', 'Chave da API', { secret: true }),
    ],
  },
};

export function newConnection(type) {
  const def = CONNECTOR_TYPES[type];
  const conn = { id: `c${Date.now().toString(36)}`, type, name: def.label, status: null };
  for (const f of def.fields) conn[f.key] = f.default ?? '';
  return conn;
}

// Só o fim da chave aparece na tela.
export const maskSecret = (value) => (value ? `••••${String(value).slice(-4)}` : '');

const fill = (template, vars, encode) =>
  String(template ?? '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : encode ? encodeURIComponent(vars[k]) : vars[k]));

export function buildRequest(conn, vars = {}) {
  if (conn.type === 'cosmos') {
    return {
      url: `${conn.baseUrl.replace(/\/+$/, '')}/gtins/${encodeURIComponent(vars.gtin)}.json`,
      headers: { 'X-Cosmos-Token': conn.token, 'User-Agent': conn.userAgent || 'Cosmos-API-Request', Accept: 'application/json' },
    };
  }
  const base = String(conn.baseUrl ?? '').replace(/\/+$/, '');
  const path = fill(conn.path || '/', vars, true);
  const headers = { Accept: 'application/json' };
  if (conn.authHeader && conn.key) headers[conn.authHeader] = fill(conn.authValue || '{chave}', { chave: conn.key }, false);
  return { url: `${base}${path.startsWith('/') ? '' : '/'}${path}`, headers };
}

export function validateConnection(conn) {
  const def = CONNECTOR_TYPES[conn.type];
  const problems = [];
  if (!/^https:\/\/[^/\s]+/i.test(conn.baseUrl ?? '')) problems.push('O endereço precisa começar com https://');
  for (const f of def.fields) if (f.secret && !conn[f.key]) problems.push(`Falta: ${f.label}`);
  if (conn.type === 'sales' && (!conn.dateField || !conn.unitsField || !(conn.eanField || conn.skuField))) {
    problems.push('Informe os campos de data, quantidade e EAN ou SKU');
  }
  return problems;
}

export function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

// Resposta JSON da base de vendas -> vendas normalizadas da loja.
export function salesFromJson(json, conn, storeId) {
  const list = getPath(json, conn.listPath);
  if (!Array.isArray(list)) {
    return { rows: [], errors: [{ line: 0, text: `“${conn.listPath || 'raiz'}” não é uma lista no JSON recebido` }] };
  }
  const records = list.map((item) => ({
    date: getPath(item, conn.dateField),
    ean: conn.eanField ? getPath(item, conn.eanField) : '',
    sku: conn.skuField ? getPath(item, conn.skuField) : '',
    units: getPath(item, conn.unitsField),
    revenue: conn.revenueField ? getPath(item, conn.revenueField) : 0,
  }));
  const columns = Object.fromEntries(
    ['date', 'ean', 'sku', 'units', 'revenue'].filter((k) => k !== 'sku' || conn.skuField).map((k) => [k, { header: k, scale: 1 }]),
  );
  if (!conn.eanField) delete columns.ean;
  return parseSalesRecords(records, { defaultStoreId: storeId, columns });
}

// Resposta do Cosmos -> linha de cadastro (mesmo formato da planilha de produtos).
// Medidas só entram se vierem preenchidas (o Cosmos costuma devolver 0 ou nulo).
export function cosmosToProductRow(json, sku) {
  const row = { sku, ean: String(json?.gtin ?? '').replace(/\D/g, '') };
  if (json?.description) row.name = json.description;
  if (json?.brand?.name) row.brand = json.brand.name;
  for (const [ours, theirs] of [
    ['width', 'width'],
    ['height', 'height'],
    ['depth', 'length'],
  ]) {
    if (Number(json?.[theirs]) > 0) row[ours] = Number(json[theirs]);
  }
  return row;
}

// Chamada pelo servidor local (navegador não define User-Agent e muitas APIs bloqueiam CORS).
export async function proxyFetch({ url, headers }) {
  let res;
  try {
    res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Planograma-Proxy': '1' },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    throw new Error('Servidor local fora do ar: abra o Studio com “npm start”.');
  }
  if (res.status === 404) throw new Error('Este Studio não está rodando pelo servidor local (npm start), então não alcança APIs externas.');
  const out = await res.json().catch(() => ({ error: `resposta inválida do servidor local (${res.status})` }));
  if (out.error) throw new Error(out.error);
  return out; // { status, contentType, body }
}

export function describeHttp(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'chave recusada (401/403)';
  if (status === 404) return 'não encontrado (404)';
  if (status === 429) return 'limite de consultas atingido (429)';
  return `erro ${status}`;
}

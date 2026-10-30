import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRequest,
  cosmosToProductRow,
  getPath,
  maskSecret,
  newConnection,
  salesFromJson,
  validateConnection,
} from '../src/integrations.js';

test('Cosmos: URL por GTIN com token e User-Agent', () => {
  const conn = { ...newConnection('cosmos'), token: 'abc123' };
  const req = buildRequest(conn, { gtin: '7891000100103' });
  assert.equal(req.url, 'https://api.cosmos.bluesoft.com.br/gtins/7891000100103.json');
  assert.equal(req.headers['X-Cosmos-Token'], 'abc123');
  assert.equal(req.headers['User-Agent'], 'Cosmos-API-Request');
});

test('base de vendas: variáveis codificadas na URL e chave no cabeçalho', () => {
  const conn = { ...newConnection('sales'), baseUrl: 'https://erp.exemplo.com/api/', key: 'segredo' };
  const req = buildRequest(conn, { loja: 'Loja 01/Centro', inicio: '2026-09-01', fim: '2026-10-29' });
  assert.equal(req.url, 'https://erp.exemplo.com/api/vendas?loja=Loja%2001%2FCentro&inicio=2026-09-01&fim=2026-10-29');
  assert.equal(req.headers.Authorization, 'Bearer segredo');
  assert.equal(maskSecret('segredo'), '••••redo');
});

test('validação aponta o que falta e exige https', () => {
  const conn = { ...newConnection('sales'), baseUrl: 'http://erp.exemplo.com' };
  const problems = validateConnection(conn);
  assert.ok(problems.some((p) => /https/.test(p)));
  assert.ok(problems.some((p) => /Chave da API/.test(p)));
});

test('JSON da base de vendas vira vendas da loja (campos aninhados)', () => {
  const conn = { ...newConnection('sales'), listPath: 'data.itens', dateField: 'dia', eanField: 'produto.ean', unitsField: 'qtd', revenueField: 'total' };
  const json = { data: { itens: [{ dia: '01/10/2026', produto: { ean: '7891000100103' }, qtd: '3', total: '10,47' }, { dia: 'x', produto: {}, qtd: 1 }] } };
  const { rows, errors } = salesFromJson(json, conn, 'L01');
  assert.deepEqual(rows, [{ storeId: 'L01', date: '2026-10-01', ean: '7891000100103', sku: '', units: 3, revenue: 10.47 }]);
  assert.equal(errors.length, 1);
  assert.match(salesFromJson({ data: {} }, conn, 'L01').errors[0].text, /não é uma lista/);
  assert.equal(getPath({ a: { b: [1] } }, 'a.b.0'), 1);
});

test('Cosmos: medidas zeradas não sobrescrevem o cadastro', () => {
  const row = cosmosToProductRow({ gtin: 7891000100103, description: 'BISCOITO X', brand: { name: 'MARCA' }, width: 0, height: 14.5, length: null }, 'S1');
  assert.deepEqual(row, { sku: 'S1', ean: '7891000100103', name: 'BISCOITO X', brand: 'MARCA', height: 14.5 });
});

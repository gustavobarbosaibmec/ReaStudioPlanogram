import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCsv } from '../src/csv.js';
import { sampleProducts, sampleStores } from '../src/data.js';
import { viradaOf } from '../src/pack.js';
import { addDays, compareTurnover, mergeSales, parseDate, parseSalesRecords } from '../src/sales.js';

test('datas em formato brasileiro e ISO; data impossível é recusada', () => {
  assert.equal(parseDate('29/10/2026'), '2026-10-29');
  assert.equal(parseDate('1-2-26'), '2026-02-01');
  assert.equal(parseDate('2026-10-29T22:10:00'), '2026-10-29');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('planilha de vendas: loja pelo código na base, nome ou id; loja desconhecida avisa', () => {
  const stores = [{ ...sampleStores[0], code: '0101' }, sampleStores[1]];
  const csv = [
    'Data;Filial;EAN;Qtd;Valor',
    `01/10/2026;0101;${sampleProducts[0].ean};3;10,47`,
    `01/10/2026;Loja 02 · Bairro;${sampleProducts[0].ean};2;6,98`,
    `01/10/2026;9999;${sampleProducts[0].ean};1;3,49`,
    `32/10/2026;0101;${sampleProducts[0].ean};1;3,49`,
  ].join('\n');
  const { rows, errors } = parseSalesRecords(parseCsv(csv), { stores });
  assert.deepEqual(rows.map((r) => [r.storeId, r.units, r.revenue]), [['L01', 3, 10.47], ['L02', 2, 6.98]]);
  assert.ok(errors.some((e) => /9999/.test(e.text)));
  assert.ok(errors.some((e) => e.line === 5 && /data inválida/.test(e.text)));
});

test('sem coluna de loja usa a loja escolhida; faltando colunas, explica', () => {
  const ok = parseSalesRecords(parseCsv('dia;sku;unidades\n2026-10-01;7890001;4\n'), { defaultStoreId: 'L03' });
  assert.equal(ok.rows[0].storeId, 'L03');
  const bad = parseSalesRecords(parseCsv('dia;valor\n2026-10-01;4\n'), { defaultStoreId: 'L03' });
  assert.match(bad.errors[0].text, /Faltam colunas: units, ean ou sku/);
});

test('reimportar não duplica; linhas do mesmo dia e produto no arquivo somam', () => {
  const r = (date, units) => ({ storeId: 'L01', date, ean: sampleProducts[0].ean, sku: '', units, revenue: units });
  const first = mergeSales([], [r('2026-10-01', 2), r('2026-10-01', 3), r('2026-10-02', 1)]);
  assert.deepEqual(first.rows.map((x) => x.units), [5, 1]);
  const again = mergeSales(first.rows, [r('2026-10-02', 7)]);
  assert.equal(again.replaced, 1);
  assert.deepEqual(again.rows.map((x) => x.units), [5, 7]);
});

function series(from, days, unitsOf) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    sampleProducts.slice(0, 3).forEach((p, k) => rows.push({ storeId: 'L01', date, ean: p.ean, sku: p.sku, units: unitsOf(date, k), revenue: unitsOf(date, k) * p.price }));
  }
  return rows;
}

test('antes × depois: médias diárias, dia da virada fora, escopo da categoria', () => {
  const virada = '2026-10-01';
  const rows = series('2026-09-01', 60, (date, k) => (date < virada ? 10 : date === virada ? 999 : k === 0 ? 15 : 10));
  rows.push({ storeId: 'L01', date: '2026-10-05', ean: '7890000000000', sku: 'outra', units: 500, revenue: 500 });
  const res = compareTurnover(rows, virada, { days: 28, products: sampleProducts });
  assert.equal(res.before.from, '2026-09-03');
  assert.equal(res.after.to, '2026-10-29');
  assert.equal(res.before.unitsPerDay, 30);
  assert.equal(res.after.unitsPerDay, 35);
  assert.ok(Math.abs(res.change.units - 35 / 30 + 1) < 1e-9);
  assert.equal(res.bySku[0].label, sampleProducts[0].name, 'maior ganho primeiro');
  assert.ok(Math.abs(res.bySku[0].change - 0.5) < 1e-9);
  assert.ok(!res.bySku.some((g) => g.label === '7890000000000'), 'venda fora da categoria não entra');
  assert.deepEqual(res.warnings, []);
});

test('janela depois ainda aberta e buracos nos dados geram aviso', () => {
  const rows = series('2026-09-01', 40, () => 1).filter((r) => r.date.slice(-1) !== '5');
  const res = compareTurnover(rows, '2026-10-01', { days: 28, products: sampleProducts, today: '2026-10-10' });
  assert.equal(res.after.to, '2026-10-10');
  assert.ok(res.warnings.some((w) => /ainda não fechou/.test(w)));
});

test('virada só conta com fotos do antes e do depois numa execução concluída', () => {
  const ph = (kind, takenAt) => ({ id: kind + takenAt, kind, takenAt, dataUrl: 'data:image/jpeg;base64,AA' });
  assert.deepEqual(viradaOf({ status: 'concluido', photos: [ph('depois', '2026-10-01T12:00:00')] }).missing, ['antes']);
  assert.equal(viradaOf({ status: 'em_execucao', photos: [ph('antes', '2026-10-01T09:00:00'), ph('depois', '2026-10-01T12:00:00')] }).counted, false);
  assert.equal(viradaOf({ status: 'concluido', photos: [{ dataUrl: 'x', takenAt: '2026-10-01T12:00:00' }] }).counted, false, 'foto sem tipo não conta');
  const ok = viradaOf({
    status: 'aprovado',
    photos: [ph('antes', '2026-10-01T09:00:00'), ph('depois', '2026-10-01T11:00:00'), ph('depois', '2026-10-02T10:00:00')],
  });
  assert.deepEqual({ counted: ok.counted, date: ok.date }, { counted: true, date: '2026-10-02' });
});

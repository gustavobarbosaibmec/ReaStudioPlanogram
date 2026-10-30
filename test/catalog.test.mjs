import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  codeFromFileName,
  gtinKey,
  isValidGtin,
  mapColumns,
  matchImages,
  mergeProducts,
  parseProductRecords,
  ratioCheck,
} from '../src/catalog.js';
import { parseCsv } from '../src/csv.js';
import { sampleProducts } from '../src/data.js';

test('GTIN: dígito verificador e equivalência EAN-13 / GTIN-14', () => {
  assert.ok(isValidGtin('7891000100103'));
  assert.ok(!isValidGtin('7891000100104'));
  assert.ok(isValidGtin('96385074')); // GTIN-8
  assert.equal(gtinKey('7891000100103'), gtinKey('07891000100103'));
});

test('cabeçalhos em português, com acento e unidade em mm', () => {
  const map = mapColumns(['Código de barras', 'Código', 'Descrição', 'Largura (mm)', 'Altura (cm)', 'Prof.', 'Preço (R$)']);
  assert.equal(map.ean.header, 'Código de barras');
  assert.equal(map.sku.header, 'Código');
  assert.equal(map.width.scale, 0.1);
  assert.equal(map.height.scale, 1);
  assert.equal(map.depth.header, 'Prof.');
  assert.equal(map.price.header, 'Preço (R$)');
});

test('planilha com vírgula decimal e mm vira cm; erros apontam a linha', () => {
  const csv = 'EAN;Descrição;Largura (mm);Altura (mm);Profundidade (mm)\n7891000100103;Biscoito X;60;140,5;45\n7891000100104;Ruim;abc;10;10\n';
  const { rows, errors } = parseProductRecords(parseCsv(csv));
  assert.deepEqual({ w: rows[0].width, h: rows[0].height, d: rows[0].depth }, { w: 6, h: 14.05, d: 4.5 });
  assert.ok(errors.some((e) => e.line === 3 && /dígito/.test(e.text)));
  assert.ok(errors.some((e) => e.line === 3 && /não é número/.test(e.text)));
});

test('mesclar atualiza pelo EAN, cria novos e desativa quem está sem medida', () => {
  const base = sampleProducts.slice(0, 2);
  const rows = [
    { line: 2, ean: `0${base[0].ean}`, width: 6.5 },
    { line: 3, ean: '7891000999998', name: 'Novo sem medida' },
  ];
  const { products, summary } = mergeProducts(base, rows);
  assert.equal(summary.updated, 1);
  assert.equal(summary.added, 1);
  assert.equal(products[0].width, 6.5);
  assert.equal(products[0].name, base[0].name, 'campos ausentes na planilha não são apagados');
  assert.equal(products.at(-1).active, false);
  assert.deepEqual(summary.incomplete, ['7891000999998']);
  assert.equal(base[0].width, 6, 'não altera o array original');
});

test('nome do arquivo: EAN em qualquer parte, frente tem prioridade, lateral é ignorada', () => {
  const [a, b] = sampleProducts;
  assert.equal(codeFromFileName(`fotos/${a.ean}_frente.PNG`).gtin, a.ean);
  const files = [
    { name: `${a.ean}_lado.jpg` },
    { name: `${a.ean}-2.jpg` },
    { name: `${a.ean}_frente.jpg` },
    { name: `${b.sku}.png` },
    { name: '7891000100104.png' },
    { name: '7891000999998.png' },
    { name: 'logo.png' },
  ];
  const { matched, unknown, missing } = matchImages(files, sampleProducts);
  const ma = matched.find((m) => m.product.sku === a.sku);
  assert.equal(ma.file.name, `${a.ean}_frente.jpg`);
  assert.equal(ma.extra.length, 1);
  assert.ok(matched.some((m) => m.product.sku === b.sku), 'SKU no nome também associa');
  assert.match(unknown.find((u) => u.file.name.includes('_lado')).reason, /lateral/);
  assert.match(unknown.find((u) => u.file.name === '7891000100104.png').reason, /não é um EAN válido/);
  assert.match(unknown.find((u) => u.file.name === '7891000999998.png').reason, /não está no cadastro/);
  assert.match(unknown.find((u) => u.file.name === 'logo.png').reason, /sem EAN/);
  assert.equal(missing.length, sampleProducts.length - 2);
});

test('proporção da foto denuncia medidas trocadas', () => {
  const p = { width: 6, height: 14 };
  assert.equal(ratioCheck(p, 300, 700).level, 'ok');
  const rotated = ratioCheck(p, 700, 300);
  assert.equal(rotated.level, 'bad');
  assert.ok(rotated.rotated);
  assert.equal(ratioCheck(p, 300, 560).level, 'warn');
});

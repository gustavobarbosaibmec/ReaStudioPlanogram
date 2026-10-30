import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleFixture, sampleProducts, sampleRules, sampleStores } from '../src/data.js';
import {
  allocate,
  allocateInt,
  buildShelves,
  generatePlanogram,
  localizeInputs,
  requiredFacings,
} from '../src/engine.js';
import { evaluate } from '../src/metrics.js';

const build = (overrides = {}) =>
  generatePlanogram({
    products: overrides.products ?? sampleProducts,
    fixture: { ...sampleFixture, ...overrides.fixture },
    rules: { ...sampleRules, ...overrides.rules },
  });

test('allocate respeita mínimos e soma o total', () => {
  const out = allocate(100, [90, 10], [0, 30]);
  assert.deepEqual(out, [70, 30]);
  assert.deepEqual(allocateInt(5, [1, 1, 1], [1, 1, 1]).reduce((a, b) => a + b), 5);
});

test('frentes atendem o DOS alvo dentro dos limites', () => {
  const shelf = buildShelves(sampleFixture)[0];
  const p = sampleProducts[0]; // 84 un/sem = 12/dia; 2 de altura x 10 de fundo = 20 por frente
  assert.equal(requiredFacings(p, shelf, sampleRules), Math.ceil((12 * 7) / 20));
  assert.equal(requiredFacings({ ...p, weeklyUnits: 10_000 }, shelf, sampleRules), sampleRules.maxFacings);
});

test('planograma gerado não tem sobreposição nem sai da gôndola', () => {
  const plan = build();
  const result = evaluate(plan, sampleProducts, sampleRules);
  assert.equal(result.kpis.errors, 0, JSON.stringify(result.issues.filter((i) => i.level === 'error')));
  assert.equal(result.kpis.skus, sampleProducts.length);
  assert.ok(result.kpis.fill > 0.75, `ocupação ${result.kpis.fill}`);
});

test('bloco vertical mantém cada subcategoria numa faixa contínua', () => {
  const plan = build({ rules: { blocking: [{ ...sampleRules.blocking[0] }] } });
  const bySub = new Map();
  for (const pos of plan.positions) {
    const sub = pos.blockPath[0];
    const r = bySub.get(sub) ?? { x0: Infinity, x1: -Infinity };
    bySub.set(sub, { x0: Math.min(r.x0, pos.x), x1: Math.max(r.x1, pos.x + pos.width) });
  }
  const ranges = [...bySub.values()].sort((a, b) => a.x0 - b.x0);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i].x0 >= ranges[i - 1].x1 - 1e-6);
});

test('encaixe em módulos alinha os blocos às divisões da gôndola', () => {
  const plan = build({ fixture: { bayCount: 10, bayWidth: 30 }, rules: { snapToBays: true } });
  assert.deepEqual(plan.warnings, []);
  for (const b of plan.blocks) assert.equal(b.x0 % 30, 0, `${b.path.join('/')} começa em ${b.x0}`);
});

test('encaixe impossível é avisado e não deixa bloco sem largura', () => {
  const plan = build({ fixture: { bayCount: 2 }, rules: { snapToBays: true } });
  assert.ok(plan.warnings.some((w) => w.includes('Encaixe')));
  assert.ok(plan.blocks.every((b) => b.x1 > b.x0));
});

test('gôndola pequena deixa SKUs de fora com motivo', () => {
  const plan = build({ fixture: { bayCount: 1, shelfCount: 2 } });
  assert.ok(plan.unplaced.length > 0);
  assert.ok(plan.unplaced.every((u) => u.reason));
});

test('produto mais alto que o vão não entra', () => {
  const tall = { ...sampleProducts[0], sku: 'ALTO', height: 60 };
  const plan = build({ products: [...sampleProducts, tall] });
  assert.ok(plan.unplaced.some((u) => u.sku === 'ALTO'));
});

test('loja aplica módulos, índice de venda e deslistagem', () => {
  const store = sampleStores[1];
  const local = localizeInputs({ products: sampleProducts, fixture: sampleFixture }, store);
  assert.equal(local.fixture.bayCount, store.bayCount);
  assert.ok(!local.products.some((p) => store.delisted.includes(p.sku)));
  const base = sampleProducts.find((p) => p.subcategory === 'Recheado');
  assert.equal(local.products.find((p) => p.sku === base.sku).weeklyUnits, base.weeklyUnits * 1.3);
});

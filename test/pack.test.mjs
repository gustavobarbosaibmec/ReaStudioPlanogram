import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ean13 } from '../src/catalog.js';
import { sampleCategory, sampleFixture, sampleProducts, sampleRules, sampleStores } from '../src/data.js';
import { generatePlanogram, localizeInputs } from '../src/engine.js';
import {
  applyPack,
  compliance,
  makePack,
  makeImagePack,
  makeReport,
  missingImageKeys,
  packKind,
  parseImagePack,
  mergeReports,
  parsePack,
  parseReport,
  publishPlanogram,
} from '../src/pack.js';

function publishAll(version = 1) {
  return sampleStores.map((store) => {
    const inputs = localizeInputs({ products: sampleProducts, fixture: sampleFixture }, store);
    const plan = generatePlanogram({ ...inputs, rules: sampleRules });
    return publishPlanogram({ store, category: sampleCategory, plan, products: inputs.products, version });
  });
}

const roundTrip = (v) => JSON.parse(JSON.stringify(v));

test('EAN-13 de exemplo tem dígito verificador válido', () => {
  assert.equal(ean13('789100000001'), '7891000000014');
  for (const p of sampleProducts) assert.match(p.ean, /^\d{13}$/);
});

test('pacote leva só os produtos usados e sobrevive a JSON', () => {
  const pack = parsePack(roundTrip(makePack({ planograms: publishAll() })));
  assert.equal(pack.planograms.length, sampleStores.length);
  const bairro = pack.planograms.find((p) => p.storeId === 'L02');
  assert.ok(!bairro.products.some((p) => sampleStores[1].delisted.includes(p.sku)));
  assert.ok(bairro.positions.every((pos) => bairro.products.some((p) => p.sku === pos.sku)));
});

test('pacote inválido é recusado com mensagem', () => {
  assert.throws(() => parsePack({ format: 'outro' }), /não é um pacote/);
  assert.throws(() => parsePack({ format: 'planogram-pack/v1', planograms: [{ id: 'x' }] }), /inválido/);
});

test('nova versão substitui a tarefa; mesma versão é ignorada', () => {
  const first = applyPack([], parsePack(makePack({ planograms: publishAll(1) })));
  assert.equal(first.summary.added, 3);
  const task = { ...first.tasks[0], status: 'em_execucao', checks: { a: { state: 'ok' } } };
  const again = applyPack([task, ...first.tasks.slice(1)], parsePack(makePack({ planograms: publishAll(1) })));
  assert.equal(again.summary.ignored, 3);
  assert.equal(again.tasks.find((t) => t.id === task.id).status, 'em_execucao');
  const v2 = applyPack(again.tasks, parsePack(makePack({ planograms: publishAll(2) })));
  assert.equal(v2.summary.updated, 3);
  assert.ok(v2.tasks.every((t) => t.status === 'novo' && t.version === 2));
});

test('revisão do escritório devolve ou aprova a versão certa', () => {
  const { tasks } = applyPack([], parsePack(makePack({ planograms: publishAll(1) })));
  const done = tasks.map((t) => ({ ...t, status: 'concluido' }));
  const [a, b] = done;
  const reviews = {
    [a.id]: { status: 'devolvido', comment: 'Foto sem a gôndola inteira', version: 1 },
    [b.id]: { status: 'aprovado', version: 2 },
  };
  const out = applyPack(done, parsePack(makePack({ planograms: [], reviews })));
  assert.equal(out.summary.reviewed, 1);
  assert.equal(out.tasks.find((t) => t.id === a.id).status, 'devolvido');
  assert.equal(out.tasks.find((t) => t.id === a.id).officeComment, 'Foto sem a gôndola inteira');
  assert.equal(out.tasks.find((t) => t.id === b.id).status, 'concluido');
});

test('relatório do promotor chega ao escritório com conformidade', () => {
  const { tasks } = applyPack([], parsePack(makePack({ planograms: publishAll(1) })));
  const t = tasks[0];
  const [p1, p2] = t.planogram.positions;
  const done = {
    ...t,
    status: 'concluido',
    startedAt: '2026-10-29T10:00:00.000Z',
    finishedAt: '2026-10-29T10:42:00.000Z',
    checks: { [p1.id]: { state: 'ok' }, [p2.id]: { state: 'problem', issue: 'ruptura', note: '' } },
    photos: [{ id: 'f1', dataUrl: 'data:image/jpeg;base64,AA==', takenAt: '2026-10-29T10:40:00.000Z' }],
  };
  assert.equal(compliance(done).problems, 1);
  const report = parseReport(roundTrip(makeReport([done, tasks[1]], 'teste')));
  assert.equal(report.tasks.length, 1, 'tarefas ainda novas não vão no relatório');
  assert.equal(report.tasks[0].durationMs, 42 * 60000);
  const { reports, merged } = mergeReports({}, report);
  assert.equal(merged, 1);
  assert.equal(reports[t.id].compliance.byIssue.ruptura, 1);
  assert.equal(mergeReports(reports, { ...report, tasks: [{ ...report.tasks[0], version: 0 }] }).merged, 0);
});

test('relatório leva SKU e prateleira de cada conferência', () => {
  const { tasks } = applyPack([], parsePack(makePack({ planograms: publishAll(1) })));
  const t = tasks[0];
  const pos = t.planogram.positions[3];
  const report = makeReport([{ ...t, status: 'concluido', checks: { [pos.id]: { state: 'problem', issue: 'preco' } } }]);
  assert.deepEqual(
    { sku: report.tasks[0].checks[pos.id].sku, shelf: report.tasks[0].checks[pos.id].shelf },
    { sku: pos.sku, shelf: pos.shelf },
  );
});

test('pacote de imagens é separado; planograma leva só a chave', () => {
  const store = sampleStores[0];
  const products = sampleProducts.map((p, i) => (i === 0 ? { ...p, imageKey: 'k1', image: 'data:image/webp;base64,AA' } : p));
  const plan = generatePlanogram({ products, fixture: sampleFixture, rules: sampleRules });
  const pub = publishPlanogram({ store, category: sampleCategory, plan, products, version: 1 });
  const first = pub.products.find((p) => p.sku === sampleProducts[0].sku);
  assert.equal(first.imageKey, 'k1');
  assert.equal(first.image, undefined, 'a foto não vai embutida no pacote de planogramas');
  assert.deepEqual(missingImageKeys([pub], new Set()), ['k1']);
  assert.deepEqual(missingImageKeys([pub], new Set(['k1'])), []);
  const images = parseImagePack(roundTrip(makeImagePack({ k1: 'data:image/webp;base64,AA', ruim: 'javascript:alert(1)' })));
  assert.deepEqual(Object.keys(images), ['k1'], 'só aceita data:image');
  assert.equal(packKind(makeImagePack({})), 'images');
  assert.equal(packKind(makePack({ planograms: [] })), 'planograms');
  assert.throws(() => packKind({ format: 'x' }), /não reconhecido/);
});

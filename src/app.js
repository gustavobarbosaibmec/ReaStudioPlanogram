// Escritório: planejamento, lojas, publicação para o app do promotor e revisão da execução.

import { imageKeyFor, matchImages, mergeProducts, parseProductRecords, ratioCheck } from './catalog.js';
import { parseCsv, toCsv } from './csv.js';
import { PRODUCT_FIELDS, sampleCategory, sampleFixture, sampleProducts, sampleRules, sampleStores } from './data.js';
import { fixtureWidth, generatePlanogram, localizeInputs, makePosition, unitsDeep, unitsHigh } from './engine.js';
import { filesFromDrop, isImageFile, processProductImage, readJsonFile, saveFile } from './files.js';
import { evaluate } from './metrics.js';
import {
  ISSUES,
  STATUS,
  formatDuration,
  makeImagePack,
  makePack,
  mergeReports,
  parseReport,
  planogramId,
  publishPlanogram,
} from './pack.js';
import { esc, legendItems, renderPlanogram, shelfAt, slotIndex, toFixturePoint } from './render.js';
import * as store from './store.js';

const LEGACY_KEY = 'planogram-builder:v1';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = (v) => structuredClone(v);
const fmt = (v, digits = 1) =>
  Number.isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '∞';
const pct = (v) => `${fmt(v * 100, 0)}%`;
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function defaults() {
  return {
    products: clone(sampleProducts),
    fixture: clone(sampleFixture),
    rules: clone(sampleRules),
    stores: clone(sampleStores),
    category: sampleCategory,
    storeId: 'L01',
    planogram: null,
    edited: false,
    stale: false,
    selectedId: null,
    colorBy: 'brand',
    showBlocks: true,
    zoom: 1,
    tab: 'planogram',
    published: null,
    reviews: {},
    reviewId: null,
    batch: null,
  };
}

let state = defaults();
let reports = {};
let history = [];

async function load() {
  let saved = await store.get('office.state');
  if (!saved) {
    try {
      saved = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    } catch {
      saved = null;
    }
  }
  if (saved) state = { ...defaults(), ...saved, batch: null };
  images = (await store.get('office.images')) ?? {};
  // projetos antigos: sem EAN, ou com a foto embutida no produto
  let migrated = false;
  for (const p of state.products) {
    p.ean ??= '';
    p.imageKey ??= '';
    if (p.image) {
      const key = imageKeyFor(p, p.image);
      images[key] = { url: p.image, w: 0, h: 0 };
      p.imageKey = key;
      migrated = true;
    }
    delete p.image;
  }
  if (migrated) await saveImages();
  reports = (await store.get('office.reports')) ?? {};
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { batch, ...rest } = state;
    store.set('office.state', rest).catch(() => toast('Não foi possível salvar no navegador.'));
  }, 250);
}

const currentStore = () => state.stores.find((s) => s.id === state.storeId) ?? null;
const localInputs = (st = currentStore()) => localizeInputs({ products: state.products, fixture: state.fixture }, st);

function regenerate() {
  const inputs = localInputs();
  state.planogram = generatePlanogram({ ...inputs, rules: state.rules, storeId: state.storeId });
  state.edited = false;
  state.stale = false;
  state.selectedId = null;
  history = [];
  render();
}

function inputsChanged() {
  if (state.edited) {
    state.stale = true;
    render();
  } else regenerate();
}

// ---------- edição manual ----------

function editPositions(mutate) {
  history.push(clone(state.planogram.positions));
  if (history.length > 50) history.shift();
  mutate(state.planogram.positions);
  state.edited = true;
  render();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  state.planogram.positions = prev;
  // o histórico começa em cada geração: sem histórico, voltamos ao gerado
  if (history.length === 0) state.edited = state.stale = false;
  if (!state.planogram.positions.some((p) => p.id === state.selectedId)) state.selectedId = null;
  render();
}

const productBySku = (sku) => localInputs().products.find((p) => p.sku === sku);

function refit(pos) {
  const product = productBySku(pos.sku);
  const shelf = state.planogram.shelves[pos.shelf];
  pos.width = pos.facings * product.width;
  pos.high = unitsHigh(product, shelf.clearance, state.rules);
  pos.deep = unitsDeep(product, shelf.depth);
}

function changeFacings(id, delta) {
  editPositions((positions) => {
    const pos = positions.find((p) => p.id === id);
    pos.facings = Math.max(1, pos.facings + delta);
    refit(pos);
  });
}

function removePosition(id) {
  state.selectedId = null;
  editPositions((positions) => positions.splice(positions.findIndex((p) => p.id === id), 1));
}

function compactShelf(shelfIndex) {
  editPositions((positions) => {
    let x = 0;
    for (const pos of positions.filter((p) => p.shelf === shelfIndex).sort((a, b) => a.x - b.x)) {
      pos.x = x;
      x += pos.width;
    }
  });
}

function insertProduct(sku) {
  const product = productBySku(sku);
  const width = fixtureWidth(state.planogram.fixture);
  const facings = Math.max(1, state.rules.minFacings);
  const options = state.planogram.shelves
    .filter((s) => unitsHigh(product, s.clearance, state.rules) > 0)
    .map((s) => {
      const end = Math.max(0, ...state.planogram.positions.filter((p) => p.shelf === s.index).map((p) => p.x + p.width));
      return { shelf: s, end, free: width - end };
    })
    .filter((o) => o.free >= facings * product.width - 1e-6)
    .sort((a, b) => b.free - a.free);
  if (options.length === 0) {
    toast(`Sem espaço livre no fim das prateleiras para ${product.name}. Reduza frentes ou compacte.`);
    return;
  }
  const pos = makePosition(product, options[0].shelf, options[0].end, facings, ['Manual'], state.rules);
  state.selectedId = pos.id;
  editPositions((positions) => positions.push(pos));
}

function wireCanvas() {
  const canvas = $('#canvas');
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('g.pos');
    if (!g) {
      if (state.selectedId) {
        state.selectedId = null;
        render();
      }
      return;
    }
    const svg = canvas.querySelector('svg');
    const pos = state.planogram.positions.find((p) => p.id === g.dataset.id);
    const start = toFixturePoint(svg, e.clientX, e.clientY, state.planogram.fixture);
    drag = { g, svg, pos, start, dx: 0, dy: 0, point: start };
    svg.setPointerCapture(e.pointerId);
    g.classList.add('is-dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toFixturePoint(drag.svg, e.clientX, e.clientY, state.planogram.fixture);
    drag.dx = p.x - drag.start.x;
    drag.dy = p.y - drag.start.y;
    drag.point = p;
    drag.g.setAttribute('transform', `translate(${drag.dx} ${-drag.dy})`);
  });

  const finish = () => {
    if (!drag) return;
    const { pos, dx, dy, point } = drag;
    drag = null;
    state.selectedId = pos.id;
    if (Math.hypot(dx, dy) < 0.8) {
      render();
      return;
    }
    const shelf = shelfAt(state.planogram.shelves, point.y);
    const maxX = fixtureWidth(state.planogram.fixture) - pos.width;
    editPositions((positions) => {
      const target = positions.find((p) => p.id === pos.id);
      target.shelf = shelf.index;
      target.x = Math.min(Math.max(0, Math.round((pos.x + dx) * 2) / 2), Math.max(0, maxX));
      refit(target);
    });
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === 'Escape') $('#lightbox').hidden = true;
    if (!state.selectedId || state.tab !== 'planogram') return;
    if (e.key === 'Delete' || e.key === 'Backspace') removePosition(state.selectedId);
    else if (e.key === '+' || e.key === '=') changeFacings(state.selectedId, 1);
    else if (e.key === '-') changeFacings(state.selectedId, -1);
    else if (e.key === 'Escape') {
      state.selectedId = null;
      render();
    }
  });
}

// ---------- regras e gôndola ----------

const ATTRIBUTES = [
  ['subcategory', 'Subcategoria'],
  ['brand', 'Marca'],
];
const SEQUENCES = [
  ['sales-desc', 'Maior venda primeiro'],
  ['sales-asc', 'Menor venda primeiro'],
  ['alpha', 'Alfabética'],
  ['custom', 'Ordem personalizada'],
];
const PRODUCT_SEQUENCES = [
  ['sales-desc', 'Maior venda primeiro'],
  ['height-desc', 'Mais alto primeiro'],
  ['size-asc', 'Menor embalagem primeiro'],
  ['price-asc', 'Menor preço primeiro'],
  ['name', 'Nome'],
];
const BASES = [
  ['units', 'Unidades vendidas'],
  ['revenue', 'Receita'],
  ['margin', 'Margem (R$)'],
  ['equal', 'Igual para todos'],
];

const options = (list, value) =>
  list.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('');

const numberField = (path, label, value, attrs = '') =>
  `<label class="field"><span>${label}</span><input type="number" data-bind="${path}" value="${value}" ${attrs}></label>`;

function renderConfig() {
  const f = state.fixture;
  const r = state.rules;
  $('#config').innerHTML = `
    <details open>
      <summary>Gôndola</summary>
      <div class="grid2">
        <label class="field span2"><span>Categoria</span><input type="text" data-bind="category" value="${esc(state.category)}"></label>
        ${numberField('fixture.bayCount', 'Módulos', f.bayCount, 'min="1" max="12" step="1"')}
        ${numberField('fixture.bayWidth', 'Largura módulo (cm)', f.bayWidth, 'min="30" step="1"')}
        ${numberField('fixture.height', 'Altura (cm)', f.height, 'min="60" step="1"')}
        ${numberField('fixture.depth', 'Profundidade (cm)', f.depth, 'min="10" step="1"')}
        ${numberField('fixture.shelfCount', 'Prateleiras', f.shelfCount, 'min="1" max="10" step="1"')}
        ${numberField('fixture.baseHeight', 'Base (cm)', f.baseHeight, 'min="0" step="1"')}
      </div>
      <p class="hint" id="bay-hint"></p>
    </details>
    <details open>
      <summary>Árvore de decisão</summary>
      ${r.blocking
        .map(
          (lvl, i) => `
        <div class="level">
          <div class="level-head">Nível ${i + 1}
            <button type="button" class="link" data-action="remove-level" data-index="${i}" aria-label="Remover nível ${i + 1}">remover</button></div>
          <div class="grid2">
            <label class="field"><span>Agrupar por</span><select data-bind="rules.blocking.${i}.attribute">${options(ATTRIBUTES, lvl.attribute)}</select></label>
            <label class="field"><span>Direção</span><select data-bind="rules.blocking.${i}.direction">${options(
              [
                ['vertical', 'Vertical'],
                ['horizontal', 'Horizontal'],
              ],
              lvl.direction,
            )}</select></label>
            <label class="field span2"><span>Sequência</span><select data-bind="rules.blocking.${i}.sequence">${options(SEQUENCES, lvl.sequence)}</select></label>
            ${
              lvl.sequence === 'custom'
                ? `<label class="field span2"><span>Ordem (separada por vírgula)</span><input type="text" data-bind="rules.blocking.${i}.customOrder" data-list value="${esc(
                    (lvl.customOrder ?? []).join(', '),
                  )}"></label>`
                : ''
            }
          </div>
        </div>`,
        )
        .join('')}
      ${r.blocking.length < 3 ? '<button type="button" class="btn ghost sm" data-action="add-level">+ Nível</button>' : ''}
    </details>
    <details open>
      <summary>Espaço e frentes</summary>
      <div class="grid2">
        <label class="field span2"><span>Espaço proporcional a</span><select data-bind="rules.spaceBasis">${options(BASES, r.spaceBasis)}</select></label>
        <label class="field span2"><span>Ordem no bloco</span><select data-bind="rules.productSequence">${options(
          PRODUCT_SEQUENCES,
          r.productSequence,
        )}</select></label>
        ${numberField('rules.targetDos', 'DOS alvo (dias)', r.targetDos, 'min="0.5" step="0.5"')}
        ${numberField('rules.minDos', 'DOS mínimo', r.minDos, 'min="0" step="0.5"')}
        ${numberField('rules.minFacings', 'Frentes mín.', r.minFacings, 'min="1" step="1"')}
        ${numberField('rules.maxFacings', 'Frentes máx.', r.maxFacings, 'min="1" step="1"')}
      </div>
      <label class="check"><input type="checkbox" data-bind="rules.stacking" ${r.stacking ? 'checked' : ''}> Empilhar na altura do vão</label>
      <label class="check"><input type="checkbox" data-bind="rules.snapToBays" ${r.snapToBays ? 'checked' : ''}> Encaixar blocos nos módulos</label>
    </details>`;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function wireConfig() {
  $('#config').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.bind) return;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') {
      value = Number(el.value);
      if (!Number.isFinite(value) || (value <= 0 && el.min !== '0')) return;
    } else if ('list' in el.dataset) value = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    else value = el.value.trim();
    if (el.dataset.bind === 'category') {
      state.category = value || sampleCategory;
      render();
      return;
    }
    setPath(state, el.dataset.bind, value);
    if (/\.sequence$/.test(el.dataset.bind)) renderConfig();
    inputsChanged();
  });
  $('#config').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'add-level') {
      const used = new Set(state.rules.blocking.map((l) => l.attribute));
      const attribute = ATTRIBUTES.find(([a]) => !used.has(a))?.[0] ?? 'brand';
      state.rules.blocking.push({ attribute, direction: 'vertical', sequence: 'sales-desc', customOrder: [] });
    } else if (action === 'remove-level') {
      state.rules.blocking.splice(Number(e.target.dataset.index), 1);
    } else return;
    renderConfig();
    inputsChanged();
  });
}

// ---------- planograma ----------

function renderPlanogramTab() {
  const products = withImages(localInputs().products);
  const plan = state.planogram;
  const evaluation = evaluate(plan, products, state.rules);
  const st = currentStore();

  $('#pog-eyebrow').textContent = `Planograma › ${state.category}`;
  $('#pog-title').textContent = st?.name ?? 'Gôndola base';
  $('#store-select').innerHTML =
    `<option value="">Gôndola base (sem loja)</option>` +
    state.stores.map((s) => `<option value="${esc(s.id)}" ${s.id === state.storeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('#bay-hint').textContent = st?.bayCount ? `Esta loja usa ${st.bayCount} módulo(s); o campo vale para a gôndola base.` : '';
  for (const b of $$('#color-by button')) b.setAttribute('aria-pressed', String(b.dataset.value === state.colorBy));
  $('#show-blocks').checked = state.showBlocks;
  $('#zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;

  $('#banner').innerHTML = state.stale
    ? `<div class="banner warn">As regras mudaram depois das suas edições manuais.
         <button type="button" class="btn sm" data-action="regenerate">Gerar de novo</button> descarta as edições.</div>`
    : state.edited
      ? `<div class="banner">Planograma editado à mão. <button type="button" class="link" data-action="undo">Desfazer (Ctrl+Z)</button></div>`
      : '';

  $('#canvas').innerHTML = renderPlanogram(plan, products, {
    rules: state.rules,
    colorBy: state.colorBy,
    showBlocks: state.showBlocks,
    selectedId: state.selectedId,
    dosBySku: new Map(evaluation.skus.map((s) => [s.sku, s.dos])),
    errorIds: new Set(evaluation.issues.filter((i) => i.level === 'error').map((i) => i.positionId)),
  });
  // 100% = gôndola inteira na altura da tela; acima disso, rola
  Object.assign($("#canvas svg").style, { height: `${66 * state.zoom}vh`, width: "auto", maxWidth: "none" });
  $('#legend').innerHTML = legendItems(products, state.colorBy, state.rules)
    .map(([c, label]) => `<span><i style="background:${c}"></i>${esc(label)}</span>`)
    .join('');

  const k = evaluation.kpis;
  $('#kpis').innerHTML = [
    ['SKUs', `${k.skus}/${k.skusTotal}`, '', k.skus < k.skusTotal ? 'bad' : ''],
    ['Frentes', k.facings],
    ['Ocupação', pct(k.fill), `${fmt(k.usedLinear, 0)} de ${fmt(k.totalLinear, 0)} cm`],
    ['DOS médio', `${fmt(k.avgDos)} d`],
    ['Abaixo do DOS mín.', k.belowDos, '', k.belowDos ? 'bad' : 'good'],
    ['Erros', k.errors, '', k.errors ? 'bad' : 'good'],
  ]
    .map(
      ([label, value, sub, cls = '']) =>
        `<div class="kpi ${cls}"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`,
    )
    .join('');

  const maxShare = Math.max(0.01, ...evaluation.spaceToSales.flatMap((g) => [g.spaceShare, g.salesShare]));
  $('#space-sales').innerHTML = evaluation.spaceToSales
    .map(
      (g) => `<div class="bar-row"><header><span>${esc(g.key)}</span>
        <span class="idx ${g.index < 0.8 ? 'bad' : g.index > 1.25 ? 'over' : ''}" title="espaço ÷ vendas">${pct(g.spaceShare)} · ${fmt(g.index, 2)}</span></header>
        <div class="bar"><i class="space" style="width:${(g.spaceShare / maxShare) * 100}%"></i><i class="sales" style="width:${(g.salesShare / maxShare) * 100}%"></i></div></div>`,
    )
    .join('');

  renderInspector(evaluation, products);

  const placed = new Set(plan.positions.map((p) => p.sku));
  const missing = products.filter((p) => p.active !== false && !placed.has(p.sku));
  $('#unplaced').innerHTML = missing.length
    ? missing
        .map((p) => {
          const reason = plan.unplaced.find((u) => u.sku === p.sku)?.reason ?? 'Removido do planograma';
          return `<li><div><strong>${esc(p.name)}</strong><small>${esc(reason)}</small></div>
            <button type="button" class="btn ghost sm" data-action="insert" data-sku="${esc(p.sku)}">Inserir</button></li>`;
        })
        .join('')
    : '<li class="empty">Todos os SKUs ativos estão no planograma.</li>';

  const issues = [...evaluation.issues, ...plan.warnings.map((text) => ({ level: 'info', text }))].filter(
    (i) => !(i.level === 'warn' && i.sku && !placed.has(i.sku)),
  );
  $('#issues').innerHTML = issues.length
    ? issues
        .map((i) => `<li class="${i.level}" ${i.positionId ? `data-select="${i.positionId}"` : ''}>${esc(i.text)}</li>`)
        .join('')
    : '<li class="empty">Nenhum problema encontrado.</li>';

  const rows = [...evaluation.rows].sort((a, b) => a.pos.shelf - b.pos.shelf || a.pos.x - b.pos.x);
  $('#report tbody').innerHTML = rows
    .map(
      (r) => `<tr data-select="${r.pos.id}" class="${r.pos.id === state.selectedId ? 'is-selected' : ''}">
        <td>${r.pos.shelf + 1}</td><td>${slotIndex(plan, r.pos)}</td><td>${esc(r.pos.sku)}</td><td>${esc(r.product?.name)}</td>
        <td>${esc(r.product?.brand)}</td><td>${esc((r.pos.blockPath ?? []).join(' › '))}</td><td>${r.pos.facings}</td>
        <td>${r.pos.high} × ${r.pos.deep}</td><td>${r.capacity}</td><td>${fmt(r.dos)}</td></tr>`,
    )
    .join('');
}

function renderInspector(evaluation, products) {
  const box = $('#inspector');
  const row = evaluation.rows.find((r) => r.pos.id === state.selectedId);
  if (!row || !row.product) {
    box.innerHTML = '<p class="hint">Clique num produto para editar. Arraste para mover entre prateleiras; Ctrl+Z desfaz.</p>';
    return;
  }
  const { pos, product } = row;
  const sku = evaluation.skus.find((s) => s.sku === pos.sku);
  const local = products.find((p) => p.sku === pos.sku);
  box.innerHTML = `
    <h3>${esc(product.name)}</h3>
    <p class="hint">${esc(product.brand)} · ${esc(product.subcategory)} · EAN ${esc(product.ean || '—')}</p>
    <dl>
      <dt>Posição</dt><dd>Prateleira ${pos.shelf + 1}, ${slotIndex(state.planogram, pos)}º da esquerda</dd>
      <dt>Arranjo</dt><dd>${pos.facings} fr. × ${pos.high} alt. × ${pos.deep} prof.</dd>
      <dt>Capacidade</dt><dd>${row.capacity} un. (${sku.capacity} no total)</dd>
      <dt>Venda</dt><dd>${fmt(local.weeklyUnits)} un./semana</dd>
      <dt>Estoque</dt><dd>${fmt(sku.dos)} dias (alvo ${state.rules.targetDos})</dd>
    </dl>
    <div class="stepper">
      <button type="button" class="icon-btn" data-action="facings" data-delta="-1" aria-label="Menos uma frente">−</button>
      <span>${pos.facings} frentes</span>
      <button type="button" class="icon-btn" data-action="facings" data-delta="1" aria-label="Mais uma frente">+</button>
    </div>
    <div class="row-actions">
      <button type="button" class="btn ghost sm" data-action="compact" data-shelf="${pos.shelf}">Compactar prateleira</button>
      <button type="button" class="btn danger sm" data-action="remove">Remover</button>
    </div>`;
}

// ---------- produtos e imagens ----------

// Biblioteca de imagens: chave -> { url, w, h }. Fica fora do estado para o
// salvamento automático não regravar megabytes de fotos a cada clique.
let images = {};

async function saveImages() {
  await store.set('office.images', images).catch(() => toast('Não foi possível salvar as imagens no navegador.'));
}

const withImages = (products) =>
  products.map((p) => (p.imageKey && images[p.imageKey] ? { ...p, image: images[p.imageKey].url } : p));

function setProductImage(product, processed) {
  const key = imageKeyFor(product, processed.dataUrl);
  images[key] = { url: processed.dataUrl, w: processed.width, h: processed.height };
  product.imageKey = key;
}

// Remove da biblioteca as imagens que nenhum produto usa mais.
function pruneImages() {
  const used = new Set(state.products.map((p) => p.imageKey).filter(Boolean));
  for (const key of Object.keys(images)) if (!used.has(key)) delete images[key];
}

function ratioBadge(p) {
  const img = images[p.imageKey];
  if (!img) return '';
  const r = ratioCheck(p, img.w, img.h);
  if (r.level === 'ok' || r.level === 'unknown') return '';
  return `<span class="chip ${r.level === 'bad' ? 'devolvido' : 'em_execucao'}" title="${esc(r.text)}">proporção</span>`;
}

function renderProductsTab() {
  $('#products-table thead').innerHTML =
    `<tr><th>Ativo</th><th>Foto</th>${PRODUCT_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr>`;
  $('#products-table tbody').innerHTML = state.products
    .map((p, i) => {
      const img = images[p.imageKey];
      return `<tr>
      <td><input type="checkbox" data-row="${i}" data-field="active" ${p.active !== false ? 'checked' : ''} aria-label="Ativo"></td>
      <td><div class="thumb-cell">${img ? `<img class="thumb" src="${esc(img.url)}" alt="">` : '<span class="thumb"></span>'}
        <label class="link file-label">${img ? 'trocar' : 'enviar'}<input type="file" accept="image/*" data-image="${i}" hidden></label>
        ${img ? `<button type="button" class="link danger" data-action="remove-image" data-row="${i}" aria-label="Remover foto">×</button>` : ''}
        ${ratioBadge(p)}</div></td>
      ${PRODUCT_FIELDS.map(
        ([key, label, type]) =>
          `<td class="${key}"><input type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} data-row="${i}" data-field="${key}" value="${esc(p[key])}" aria-label="${label}"></td>`,
      ).join('')}
      <td><button type="button" class="link danger" data-action="delete-product" data-row="${i}">excluir</button></td>
    </tr>`;
    })
    .join('');
  const withImg = state.products.filter((p) => images[p.imageKey]).length;
  $('#product-count').textContent =
    `${state.products.length} produtos · ${state.products.filter((p) => p.active !== false).length} ativos · ${withImg} com foto`;
  renderImport();
}

// ----- conferência de importação (imagens e planilha) -----

let pending = null; // { kind: 'progress' | 'images' | 'sheet', ... }

const ratioCell = (m, i) => {
  if (m.ratio.level === 'ok') return '<span class="chip aprovado">ok</span>';
  if (m.ratio.level === 'unknown') return '<span class="chip">sem medida</span>';
  return `<span class="chip ${m.ratio.level === 'bad' ? 'devolvido' : 'em_execucao'}">${m.ratio.level === 'bad' ? 'confira' : 'atenção'}</span>
    <small style="display:block">${esc(m.ratio.text)}</small>
    ${m.ratio.rotated ? `<button type="button" class="link" data-swap="${i}">trocar largura ↔ altura</button>` : ''}`;
};

function renderImport() {
  const box = $('#import-review');
  if (!pending) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (pending.kind === 'progress') {
    box.innerHTML = `<p><strong>Processando imagens ${pending.done}/${pending.total}…</strong></p>
      <div class="bar"><i class="space" style="width:${(pending.done / Math.max(1, pending.total)) * 100}%"></i></div>`;
    return;
  }
  if (pending.kind === 'sheet') {
    const { summary, errors, columns, products } = pending;
    const found = Object.values(columns)
      .map((c) => `${esc(c.header)}${c.scale === 0.1 ? ' (mm→cm)' : c.scale === 100 ? ' (m→cm)' : ''}`)
      .join(', ');
    box.innerHTML = `
      <div class="page-title" style="margin-bottom:.5rem"><div><span class="eyebrow">Conferência da planilha</span>
        <h1 style="font-size:1.1rem">${summary.updated} atualizado(s) · ${summary.added} novo(s)</h1></div>
        <div class="actions"><button type="button" class="btn ghost" data-import="cancel">Cancelar</button>
        <button type="button" class="btn" data-import="apply-sheet">Aplicar</button></div></div>
      <p class="hint">Colunas reconhecidas: ${found || 'nenhuma'}. Produtos já cadastrados são encontrados pelo EAN (ou SKU); campos vazios na planilha não apagam o que existe.</p>
      ${summary.incomplete.length ? `<p class="hint" style="color:var(--warn)">${summary.incomplete.length} produto(s) novo(s) sem largura, altura ou profundidade: entram desativados até completar as medidas.</p>` : ''}
      ${errors.length ? `<h2 class="section-h">Problemas (${errors.length})</h2><ul class="list issues">${errors.slice(0, 200).map((e) => `<li class="warn">Linha ${e.line}: ${esc(e.text)}</li>`).join('')}</ul>` : ''}
      <p class="hint">Total depois de aplicar: ${products.length} produtos.</p>`;
    return;
  }
  const { matched, unknown, missing } = pending;
  const flagged = matched.filter((m) => m.ratio.level === 'bad' || m.ratio.level === 'warn').length;
  const chosen = matched.filter((m) => m.use).length;
  box.innerHTML = `
    <div class="page-title" style="margin-bottom:.5rem"><div><span class="eyebrow">Conferência das imagens</span>
      <h1 style="font-size:1.1rem">${matched.length} associada(s) · ${flagged} com alerta · ${unknown.length} não reconhecida(s)</h1></div>
      <div class="actions"><button type="button" class="btn ghost" data-import="cancel">Cancelar</button>
      <button type="button" class="btn" data-import="apply-images" ${chosen ? '' : 'disabled'}>Aplicar ${chosen} imagem(ns)</button></div></div>
    <p class="hint">O nome do arquivo identifica o produto: EAN (ex.: 7891000100103.png ou 7891000100103_frente.jpg) ou o SKU. Bordas brancas ou transparentes foram cortadas. O alerta compara a proporção da foto com largura × altura cadastradas; as marcadas “confira” ficam desmarcadas.</p>
    ${
      matched.length
        ? `<div class="table-wrap"><table class="review-table"><thead><tr><th></th><th>Foto</th><th>Produto</th><th>Arquivo</th><th>L × A (cm)</th><th>Proporção</th></tr></thead><tbody>${matched
            .map(
              (m, i) => `<tr>
          <td><input type="checkbox" data-use="${i}" ${m.use ? 'checked' : ''} aria-label="Usar esta imagem"></td>
          <td><img class="thumb lg" src="${esc(m.processed.dataUrl)}" alt=""></td>
          <td><strong>${esc(m.product.name)}</strong><small class="muted" style="display:block">EAN ${esc(m.product.ean || '—')} · SKU ${esc(m.product.sku)}${m.product.imageKey ? ' · substitui a foto atual' : ''}</small></td>
          <td><small>${esc(m.file.name)}${m.extra.length ? `<br><span class="muted">+${m.extra.length} outra(s) ignorada(s)</span>` : ''}</small></td>
          <td>${m.product.width} × ${m.product.height}${m.swapped ? ' <small class="muted">(trocado)</small>' : ''}</td>
          <td>${ratioCell(m, i)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : ''
    }
    ${unknown.length ? `<h2 class="section-h">Não reconhecidas (${unknown.length})</h2><ul class="list issues">${unknown.map((u) => `<li class="warn"><div><strong>${esc(u.file.name)}</strong><small>${esc(u.reason)}</small></div></li>`).join('')}</ul>` : ''}
    ${missing.length ? `<details style="margin-top:.75rem"><summary class="hint">${missing.length} produto(s) ativo(s) continuam sem foto</summary><ul class="list">${missing.map((p) => `<li>${esc(p.name)}<small>EAN ${esc(p.ean || '—')}</small></li>`).join('')}</ul></details>` : ''}`;
}

async function importImageFiles(files) {
  const list = files.filter(isImageFile);
  if (list.length === 0) {
    toast('Nenhuma imagem encontrada (PNG, JPG ou WebP).');
    return;
  }
  const { matched, unknown, missing } = matchImages(list, state.products);
  pending = { kind: 'progress', done: 0, total: matched.length };
  renderImport();
  const ok = [];
  for (const m of matched) {
    try {
      const processed = await processProductImage(m.file);
      const ratio = ratioCheck(m.product, processed.width, processed.height);
      ok.push({ ...m, processed, ratio, use: ratio.level !== 'bad' });
    } catch (err) {
      unknown.push({ file: m.file, reason: err.message });
    }
    pending.done++;
    if (pending.done % 5 === 0 || pending.done === pending.total) renderImport();
  }
  pending = { kind: 'images', matched: ok, unknown, missing };
  renderImport();
  $('#import-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function importSheet(file) {
  const { rows, errors, columns } = parseProductRecords(parseCsv(await file.text()));
  if (!columns.sku && !columns.ean) {
    toast('A planilha precisa de uma coluna de EAN ou SKU (veja o modelo exportado).');
    return;
  }
  const { products, summary } = mergeProducts(state.products, rows);
  pending = { kind: 'sheet', products, summary, errors, columns };
  renderImport();
  $('#import-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function applyPending(kind) {
  if (kind === 'sheet') {
    state.products = pending.products;
    toast(`Planilha aplicada: ${pending.summary.updated} atualizado(s), ${pending.summary.added} novo(s).`);
  } else {
    const chosen = pending.matched.filter((m) => m.use);
    for (const m of chosen) {
      const product = state.products.find((p) => p.sku === m.product.sku);
      if (m.swapped) [product.width, product.height] = [m.product.width, m.product.height];
      setProductImage(product, m.processed);
    }
    pruneImages();
    await saveImages();
    toast(`${chosen.length} imagem(ns) aplicada(s).`);
  }
  pending = null;
  renderProductsTab();
  inputsChanged();
}

function wireProducts() {
  const table = $('#products-table');
  table.addEventListener('change', async (e) => {
    if (e.target.dataset.image !== undefined) {
      const file = e.target.files[0];
      if (!file) return;
      try {
        setProductImage(state.products[Number(e.target.dataset.image)], await processProductImage(file));
        pruneImages();
        await saveImages();
        renderProductsTab();
        inputsChanged();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    const { row, field } = e.target.dataset;
    if (row === undefined) return;
    const p = state.products[Number(row)];
    const type = PRODUCT_FIELDS.find(([k]) => k === field)?.[2];
    if (field === 'active') p.active = e.target.checked;
    else if (type === 'number') {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v < 0 || (['width', 'height', 'depth'].includes(field) && v === 0)) {
        e.target.value = p[field];
        toast('Valor inválido.');
        return;
      }
      p[field] = v;
    } else p[field] = e.target.value.trim();
    inputsChanged();
  });
  table.addEventListener('click', async (e) => {
    const { action, row } = e.target.dataset;
    if (action === 'delete-product') state.products.splice(Number(row), 1);
    else if (action === 'remove-image') state.products[Number(row)].imageKey = '';
    else return;
    pruneImages();
    await saveImages();
    renderProductsTab();
    inputsChanged();
  });
  $('#add-product').addEventListener('click', () => {
    state.products.push({
      sku: `NOVO${state.products.length + 1}`,
      ean: '',
      name: 'Novo produto',
      brand: 'Marca',
      subcategory: state.products[0]?.subcategory ?? 'Geral',
      width: 6,
      height: 15,
      depth: 5,
      weeklyUnits: 10,
      price: 3,
      margin: 0.3,
      imageKey: '',
      active: true,
    });
    renderProductsTab();
    inputsChanged();
  });
  $('#export-products').addEventListener('click', () => saveFile('produtos.csv', toCsv(state.products, PRODUCT_FIELDS), 'text/csv'));
  $('#import-products').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importSheet(file);
  });
  for (const id of ['#import-images', '#import-folder']) {
    $(id).addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      importImageFiles(files);
    });
  }
  const drop = $('#dropzone');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = await filesFromDrop(e.dataTransfer);
    const sheet = files.find((f) => /\.csv$/i.test(f.name));
    if (sheet) await importSheet(sheet);
    else importImageFiles(files);
  });
  $('#import-review').addEventListener('click', (e) => {
    const t = e.target.closest('[data-import], [data-swap]');
    if (!t) return;
    if (t.dataset.swap) {
      const m = pending.matched[Number(t.dataset.swap)];
      m.product = { ...m.product, width: m.product.height, height: m.product.width };
      m.swapped = true;
      m.ratio = ratioCheck(m.product, m.processed.width, m.processed.height);
      m.use = true;
      renderImport();
      return;
    }
    if (t.dataset.import === 'cancel') {
      pending = null;
      renderImport();
    } else applyPending(t.dataset.import === 'apply-sheet' ? 'sheet' : 'images');
  });
  $('#import-review').addEventListener('change', (e) => {
    if (e.target.dataset.use === undefined) return;
    pending.matched[Number(e.target.dataset.use)].use = e.target.checked;
    renderImport();
  });
}

// ---------- lojas ----------

const formatIndex = (idx) =>
  Object.entries(idx ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
const parseIndex = (text) =>
  Object.fromEntries(
    text
      .split(';')
      .map((s) => s.split('=').map((x) => x.trim()))
      .filter(([k, v]) => k && Number.isFinite(Number(String(v).replace(',', '.'))))
      .map(([k, v]) => [k, Number(String(v).replace(',', '.'))]),
  );

function renderStoresTab() {
  $('#stores-table tbody').innerHTML = state.stores
    .map(
      (s, i) => `<tr>
      <td><input type="text" data-store="${i}" data-field="name" value="${esc(s.name)}" aria-label="Nome"></td>
      <td><input type="number" min="1" max="12" step="1" data-store="${i}" data-field="bayCount" value="${s.bayCount}" aria-label="Módulos"></td>
      <td><input type="text" data-store="${i}" data-field="salesIndex" value="${esc(formatIndex(s.salesIndex))}" placeholder="Recheado=1.2; Wafer=0.8" aria-label="Índice de venda"></td>
      <td><input type="text" data-store="${i}" data-field="delisted" value="${esc((s.delisted ?? []).join(', '))}" placeholder="SKUs fora do sortimento" aria-label="SKUs fora"></td>
      <td><button type="button" class="link danger" data-action="delete-store" data-store="${i}">excluir</button></td>
    </tr>`,
    )
    .join('');

  const b = state.batch;
  $('#batch').innerHTML = b
    ? `<table><thead><tr><th>Loja</th><th>Módulos</th><th>SKUs</th><th>Frentes</th><th>Ocupação</th><th>DOS médio</th><th>Abaixo do mín.</th><th>Fora</th><th></th></tr></thead>
      <tbody>${b
        .map(
          (r) => `<tr><td><strong>${esc(r.name)}</strong></td><td>${r.bays}</td><td>${r.kpis.skus} / ${r.kpis.skusTotal}</td><td>${r.kpis.facings}</td>
          <td>${pct(r.kpis.fill)}</td><td>${fmt(r.kpis.avgDos)}</td><td>${r.kpis.belowDos}</td><td>${r.unplaced}</td>
          <td><button type="button" class="btn ghost sm" data-action="open-store" data-id="${esc(r.id)}">Abrir</button></td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="hint">Gere os planogramas para comparar as lojas.</p>';
}

function wireStores() {
  $('#stores-table').addEventListener('change', (e) => {
    const { store: idx, field } = e.target.dataset;
    if (idx === undefined) return;
    const s = state.stores[Number(idx)];
    if (field === 'bayCount') s.bayCount = Math.max(1, Math.round(Number(e.target.value) || 1));
    else if (field === 'salesIndex') s.salesIndex = parseIndex(e.target.value);
    else if (field === 'delisted') s.delisted = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
    else s.name = e.target.value;
    state.batch = null;
    if (s.id === state.storeId) inputsChanged();
    else render();
  });
  $('#stores-table').addEventListener('click', (e) => {
    if (e.target.dataset.action !== 'delete-store') return;
    const [removed] = state.stores.splice(Number(e.target.dataset.store), 1);
    state.batch = null;
    if (removed.id === state.storeId) {
      state.storeId = '';
      regenerate();
    } else render();
  });
  $('#add-store').addEventListener('click', () => {
    const n = state.stores.length + 1;
    state.stores.push({
      id: `L${String(Date.now()).slice(-6)}`,
      name: `Loja ${String(n).padStart(2, '0')}`,
      bayCount: state.fixture.bayCount,
      salesIndex: {},
      delisted: [],
    });
    render();
  });
  $('#run-batch').addEventListener('click', () => {
    state.batch = state.stores.map((st) => {
      const inputs = localInputs(st);
      const plan = generatePlanogram({ ...inputs, rules: state.rules, storeId: st.id });
      const { kpis } = evaluate(plan, inputs.products, state.rules);
      return { id: st.id, name: st.name, bays: inputs.fixture.bayCount, kpis, unplaced: plan.unplaced.length };
    });
    render();
  });
  $('#batch').addEventListener('click', (e) => {
    if (e.target.dataset.action !== 'open-store') return;
    state.storeId = e.target.dataset.id;
    state.tab = 'planogram';
    regenerate();
  });
}

// ---------- execução (publicar, pacote, relatórios, revisão) ----------

function publish() {
  if (state.stores.length === 0) {
    toast('Cadastre ao menos uma loja.');
    return;
  }
  const version = (state.published?.version ?? 0) + 1;
  const note = $('#publish-note').value.trim();
  const timeTracking = $('#publish-timer').checked;
  const planograms = state.stores.map((st) => {
    const inputs = localInputs(st);
    // a loja aberta no editor publica o que está na tela, inclusive edições manuais
    const plan =
      st.id === state.storeId && state.planogram
        ? state.planogram
        : generatePlanogram({ ...inputs, rules: state.rules, storeId: st.id });
    return publishPlanogram({ store: st, category: state.category, plan, products: inputs.products, version, note, timeTracking });
  });
  state.published = { version, publishedAt: new Date().toISOString(), note, timeTracking, planograms };
  toast(`Versão ${version} publicada para ${planograms.length} loja(s). Baixe o pacote e envie ao promotor.`);
  render();
}

function downloadPack() {
  if (!state.published) {
    toast('Publique uma versão antes de baixar o pacote.');
    return;
  }
  const pack = makePack({ planograms: state.published.planograms, reviews: state.reviews });
  const day = new Date().toISOString().slice(0, 10);
  saveFile(`pacote-planogramas-v${state.published.version}-${day}.json`, JSON.stringify(pack));
}

// Só as fotos dos produtos publicados; vai à parte porque pesa e muda pouco.
function publishedImages() {
  const keys = new Set((state.published?.planograms ?? []).flatMap((p) => p.products.map((x) => x.imageKey).filter(Boolean)));
  return Object.fromEntries([...keys].filter((k) => images[k]).map((k) => [k, images[k].url]));
}

function downloadImagePack() {
  const selected = publishedImages();
  if (Object.keys(selected).length === 0) {
    toast(state.published ? 'Os produtos publicados não têm foto.' : 'Publique uma versão antes.');
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  saveFile(`pacote-imagens-${day}.json`, JSON.stringify(makeImagePack(selected)));
}

const fileSize = (chars) =>
  chars < 1024 * 1024
    ? `${Math.max(1, Math.round(chars / 1024))} KB`
    : `${(chars / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

function execRows() {
  const planograms = state.published?.planograms ?? [];
  return planograms.map((p) => {
    const report = reports[p.id];
    const current = report && report.version === p.version ? report : null;
    const review = state.reviews[p.id];
    const reviewed = review && review.version === p.version && current && review.at >= (current.receivedAt ?? '');
    const status = reviewed ? review.status : (current?.status ?? 'novo');
    return { planogram: p, report: current, review, status };
  });
}

function renderExecutionTab() {
  const rows = execRows();
  const pub = state.published;
  $('#publish-info').textContent = pub ? `Versão atual: ${pub.version} · ${dateTime(pub.publishedAt)}` : 'Nada publicado ainda.';
  $('#download-pack').disabled = !pub;
  const imgs = pub ? Object.values(publishedImages()) : [];
  $('#download-images').disabled = imgs.length === 0;
  $('#images-info').textContent = !pub
    ? ''
    : imgs.length
      ? `${imgs.length} foto(s), cerca de ${fileSize(imgs.reduce((a, u) => a + u.length, 0))}. Envie de novo só quando as fotos mudarem.`
      : 'Os produtos publicados ainda não têm foto (aba Produtos › Importar imagens).';

  const done = rows.filter((r) => r.report && r.report.status === 'concluido' && r.status === 'concluido');
  const withReport = rows.filter((r) => r.report);
  const avg = (list, f) => (list.length ? list.reduce((a, r) => a + f(r), 0) / list.length : 0);
  $('#exec-kpis').innerHTML = [
    ['Lojas publicadas', rows.length],
    ['Aguardando revisão', done.length, done.length ? 'bad' : ''],
    ['Aprovadas', rows.filter((r) => r.status === 'aprovado').length, 'good'],
    ['Devolvidas', rows.filter((r) => r.status === 'devolvido').length],
    ['Conformidade média', withReport.length ? pct(avg(withReport, (r) => r.report.compliance.rate)) : '—'],
    ['Tempo médio', withReport.length ? formatDuration(avg(withReport, (r) => r.report.durationMs)) : '—'],
  ]
    .map(([label, value, cls = '']) => `<div class="kpi ${cls}"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
  $('#exec-count').hidden = done.length === 0;
  $('#exec-count').textContent = done.length;

  $('#exec-table tbody').innerHTML = rows.length
    ? rows
        .map(({ planogram: p, report: r, status }) => {
          const c = r?.compliance;
          return `<tr>
          <td><strong>${esc(p.storeName)}</strong></td><td>${esc(p.category)}</td><td>v${p.version}</td>
          <td><span class="chip ${status}">${STATUS[status]}</span></td>
          <td>${c ? `${pct(c.rate)} <small class="muted">(${c.ok}/${c.total})</small>` : '—'}</td>
          <td>${c ? c.problems : '—'}</td><td>${r ? r.photos.length : '—'}</td>
          <td>${r ? formatDuration(r.durationMs) : '—'}</td><td>${r ? dateTime(r.receivedAt) : '—'}</td>
          <td>${r ? `<button type="button" class="btn ${status === 'concluido' ? '' : 'ghost'} sm" data-action="review" data-id="${esc(p.id)}">Revisar</button>` : ''}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="10" class="muted">Publique uma versão para acompanhar a execução nas lojas.</td></tr>';

  renderReview(rows.find((r) => r.planogram.id === state.reviewId));
}

function renderReview(row) {
  const box = $('#review');
  if (!row?.report) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { planogram: p, report: r, status } = row;
  const bySku = new Map(p.products.map((x) => [x.sku, x]));
  const problems = Object.entries(r.checks)
    .filter(([, c]) => c.state === 'problem')
    .map(([id, c]) => {
      const pos = p.positions.find((x) => x.id === id);
      const sku = c.sku ?? pos?.sku;
      return { sku, shelf: c.shelf ?? pos?.shelf, product: bySku.get(sku), c };
    });
  box.innerHTML = `
    <div class="page-title" style="margin-bottom:.5rem">
      <div><span class="eyebrow">Revisão · v${p.version}</span><h1 style="font-size:1.2rem">${esc(p.storeName)} — ${esc(p.category)}</h1></div>
      <span class="chip ${status}">${STATUS[status]}</span>
    </div>
    <p class="hint">Início ${dateTime(r.startedAt)} · fim ${dateTime(r.finishedAt)} · ${formatDuration(r.durationMs)} · ${r.device ? esc(r.device) : 'aparelho não identificado'}</p>
    <div class="split">
      <div>
        <h2 style="font-size:.9rem">Fotos (${r.photos.length})</h2>
        <div class="gallery">${r.photos.map((ph) => `<img src="${esc(ph.dataUrl)}" alt="Foto da execução" data-zoom-img>`).join('') || '<p class="hint">Sem fotos.</p>'}</div>
        ${r.comment ? `<p><strong>Comentário do promotor:</strong> ${esc(r.comment)}</p>` : ''}
      </div>
      <div>
        <h2 style="font-size:.9rem">Problemas apontados (${problems.length})</h2>
        <ul class="list issues">${
          problems
            .map(
              ({ sku, shelf, product, c }) =>
                `<li class="error"><div><strong>${esc(product?.name ?? sku ?? 'Posição desconhecida')}</strong>
                <small>${ISSUES[c.issue] ?? c.issue}${Number.isInteger(shelf) ? ` · prateleira ${shelf + 1}` : ''}${c.note ? ` · ${esc(c.note)}` : ''}</small></div></li>`,
            )
            .join('') || '<li class="empty">Nenhum problema apontado.</li>'
        }</ul>
        <p class="hint">${r.compliance.checked} de ${r.compliance.total} posições conferidas.</p>
      </div>
    </div>
    <label class="field" style="margin-top:1rem"><span>Comentário para a loja</span><textarea id="review-comment" placeholder="Obrigatório para devolver">${esc(row.review?.version === p.version ? (row.review.comment ?? '') : '')}</textarea></label>
    <div class="row-actions" style="margin-top:.75rem">
      <button type="button" class="btn success" data-action="approve" data-id="${esc(p.id)}">Aprovar</button>
      <button type="button" class="btn danger" data-action="return" data-id="${esc(p.id)}">Devolver para refazer</button>
      <span class="hint" style="margin:0">A decisão vai para o promotor no próximo pacote.</span>
    </div>`;
}

function decide(id, status) {
  const row = execRows().find((r) => r.planogram.id === id);
  const comment = $('#review-comment').value.trim();
  if (status === 'devolvido' && !comment) {
    toast('Escreva o que precisa ser refeito.');
    return;
  }
  state.reviews[id] = { status, comment, version: row.planogram.version, at: new Date().toISOString() };
  toast(status === 'aprovado' ? 'Aprovado. Envie o próximo pacote para avisar a loja.' : 'Devolvido. Envie o próximo pacote para a loja refazer.');
  render();
}

function wireExecution() {
  $('#publish').addEventListener('click', publish);
  $('#download-pack').addEventListener('click', downloadPack);
  $('#download-images').addEventListener('click', downloadImagePack);
  $('#import-report').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const report = parseReport(await readJsonFile(file));
      const out = mergeReports(reports, report);
      reports = out.reports;
      await store.set('office.reports', reports);
      toast(`${out.merged} execução(ões) importada(s) de ${report.tasks.length}.`);
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#tab-execution').addEventListener('click', (e) => {
    const t = e.target.closest('[data-action], [data-zoom-img]');
    if (!t) return;
    if (t.dataset.zoomImg !== undefined) {
      $('#lightbox img').src = t.src;
      $('#lightbox').hidden = false;
    } else if (t.dataset.action === 'review') {
      state.reviewId = t.dataset.id;
      render();
      $('#review').scrollIntoView({ behavior: 'smooth' });
    } else if (t.dataset.action === 'approve') decide(t.dataset.id, 'aprovado');
    else if (t.dataset.action === 'return') decide(t.dataset.id, 'devolvido');
  });
  $('#lightbox').addEventListener('click', () => ($('#lightbox').hidden = true));
}

// ---------- geral ----------

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

function render() {
  for (const tab of $$('[role="tab"]')) {
    const active = tab.dataset.tab === state.tab;
    tab.setAttribute('aria-selected', String(active));
    $(`#tab-${tab.dataset.tab}`).hidden = !active;
  }
  if (state.tab === 'planogram') renderPlanogramTab();
  if (state.tab === 'products') renderProductsTab();
  if (state.tab === 'stores') renderStoresTab();
  renderExecutionTab();
  save();
}

function wireGeneral() {
  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    render();
  });
  $('#store-select').addEventListener('change', (e) => {
    state.storeId = e.target.value;
    regenerate();
  });
  $('#generate').addEventListener('click', regenerate);
  $('#color-by').addEventListener('click', (e) => {
    const value = e.target.dataset.value;
    if (!value) return;
    state.colorBy = value;
    render();
  });
  $('#show-blocks').addEventListener('change', (e) => {
    state.showBlocks = e.target.checked;
    render();
  });
  $('#tab-planogram').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action], [data-select], [data-zoom], [data-goto]');
    if (!target) return;
    const { action } = target.dataset;
    if (target.dataset.goto) {
      state.tab = target.dataset.goto;
      return render();
    }
    if (target.dataset.zoom) {
      state.zoom = Math.min(3, Math.max(0.5, state.zoom + Number(target.dataset.zoom) * 0.25));
      return render();
    }
    if (target.dataset.select && !action) {
      state.selectedId = target.dataset.select;
      return render();
    }
    if (action === 'facings') changeFacings(state.selectedId, Number(target.dataset.delta));
    else if (action === 'remove') removePosition(state.selectedId);
    else if (action === 'compact') compactShelf(Number(target.dataset.shelf));
    else if (action === 'insert') insertProduct(target.dataset.sku);
    else if (action === 'regenerate') regenerate();
    else if (action === 'undo') undo();
  });

  $('#export-json').addEventListener('click', () => {
    const { products, fixture, rules, stores, storeId, planogram, category, published, reviews } = state;
    saveFile(
      `projeto-${category}.json`,
      JSON.stringify({ format: 'planogram-builder/v1', products, fixture, rules, stores, storeId, planogram, category, published, reviews }),
    );
  });
  $('#export-csv').addEventListener('click', () => {
    const products = localInputs().products;
    const { rows } = evaluate(state.planogram, products, state.rules);
    const data = rows.map((r) => ({
      shelf: r.pos.shelf + 1,
      slot: slotIndex(state.planogram, r.pos),
      x: r.pos.x.toFixed(1),
      sku: r.pos.sku,
      ean: r.product?.ean,
      name: r.product?.name,
      brand: r.product?.brand,
      facings: r.pos.facings,
      high: r.pos.high,
      deep: r.pos.deep,
      capacity: r.capacity,
      dos: Number.isFinite(r.dos) ? r.dos.toFixed(1) : '',
    }));
    saveFile(
      `planograma-${state.storeId || 'base'}.csv`,
      toCsv(data, [
        ['shelf', 'Prateleira'],
        ['slot', 'Posição'],
        ['x', 'X (cm)'],
        ['sku', 'SKU'],
        ['ean', 'EAN'],
        ['name', 'Descrição'],
        ['brand', 'Marca'],
        ['facings', 'Frentes'],
        ['high', 'Altura (un.)'],
        ['deep', 'Profundidade (un.)'],
        ['capacity', 'Capacidade'],
        ['dos', 'DOS (dias)'],
      ]),
      'text/csv',
    );
  });
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = await readJsonFile(file);
      if (data.format !== 'planogram-builder/v1') throw new Error('formato desconhecido');
      state = {
        ...defaults(),
        ...data,
        stores: data.stores ?? [],
        storeId: data.storeId ?? '',
        category: data.category ?? sampleCategory,
        reviews: data.reviews ?? {},
        edited: true,
        tab: 'planogram',
      };
      history = [];
      renderConfig();
      render();
      toast('Projeto aberto.');
    } catch (err) {
      toast(`Não foi possível abrir: ${err.message}`);
    }
  });
}

await load();
renderConfig();
wireConfig();
wireCanvas();
wireProducts();
wireStores();
wireExecution();
wireGeneral();
if (state.planogram) render();
else regenerate();

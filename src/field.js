// App do promotor: recebe o pacote, mostra o planograma da loja sem internet,
// confere posição por posição, tira fotos, mede o tempo e devolve o relatório.

import { sampleCategory, sampleFixture, sampleProducts, sampleRules, sampleStores } from './data.js';
import { generatePlanogram, localizeInputs } from './engine.js';
import { compressImage, readJsonFile, saveFile } from './files.js';
import {
  ISSUES,
  STATUS,
  applyPack,
  compliance,
  durationMs,
  formatDuration,
  makePack,
  makeReport,
  missingImageKeys,
  packKind,
  parseImagePack,
  parsePack,
  publishPlanogram,
} from './pack.js';
import { colorFor, esc, renderPlanogram, slotIndex } from './render.js';
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

let tasks = [];
let images = {}; // chave -> data URL, vindo do pacote de imagens
let settings = { promoter: '' };
const ui = { filter: 'pending', mode: 'drawing', bay: 0, zoom: 1, query: '', sheet: null };
let timerHandle;

async function persist() {
  await store.set('field.tasks', tasks);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

const taskById = (id) => tasks.find((t) => t.id === id);
const editable = (t) => t.status === 'em_execucao';

function route() {
  const [, view, id] = location.hash.match(/^#(task)\/(.+)$/) ?? [];
  clearInterval(timerHandle);
  closeSheet();
  if (view === 'task' && taskById(decodeURIComponent(id))) showTask(decodeURIComponent(id));
  else showHome();
}

// ---------- início ----------

function showHome() {
  $('#view-task').hidden = true;
  $('#view-home').hidden = false;
  $('#back').hidden = true;
  $('#logo').hidden = false;
  $('#title').textContent = 'Planograma Campo';
  const pending = tasks.filter((t) => ['novo', 'em_execucao', 'devolvido'].includes(t.status)).length;
  $('#subtitle').textContent = tasks.length ? `${pending} pendente(s) · funciona sem internet` : 'Funciona sem internet';

  if (tasks.length === 0) {
    $('#view-home').innerHTML = `
      <div class="card empty-state">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="10" width="52" height="44" rx="6" fill="#eef2ff"/><rect x="10" y="22" width="44" height="2.5" rx="1" fill="#1e3a8a"/><rect x="10" y="36" width="44" height="2.5" rx="1" fill="#1e3a8a"/><rect x="13" y="13" width="6" height="9" rx="1" fill="#f59e0b"/><rect x="21" y="15" width="6" height="7" rx="1" fill="#1e3a8a" opacity=".5"/><rect x="31" y="27" width="8" height="9" rx="1" fill="#f59e0b"/></svg>
        <h2>Nenhum planograma no aparelho</h2>
        <p>Abra o pacote enviado pelo escritório (arquivo .json recebido por WhatsApp, e-mail ou Drive). Depois disso o app funciona sem internet.</p>
        <button type="button" class="btn" data-action="open-pack">Abrir pacote</button>
        <button type="button" class="btn ghost" data-action="demo">Ver demonstração</button>
      </div>`;
    return;
  }

  const filters = [
    ['pending', 'Pendentes', (t) => ['novo', 'em_execucao', 'devolvido'].includes(t.status)],
    ['done', 'Enviadas', (t) => ['concluido', 'aprovado'].includes(t.status)],
    ['all', 'Todas', () => true],
  ];
  const [, , test] = filters.find(([k]) => k === ui.filter);
  const order = { devolvido: 0, em_execucao: 1, novo: 2, concluido: 3, aprovado: 4 };
  const list = tasks.filter(test).sort((a, b) => order[a.status] - order[b.status] || a.planogram.storeName.localeCompare(b.planogram.storeName));
  const toSend = tasks.filter((t) => t.status !== 'novo').length;
  const noPhoto = missingPhotos(tasks);

  $('#view-home').innerHTML = `
    ${noPhoto ? `<div class="note" style="margin:0 0 .75rem">${noPhoto} produto(s) sem foto neste aparelho. Peça ao escritório o <strong>pacote de imagens</strong> e abra em “Receber pacote”.</div>` : ''}
    <div class="home-actions">
      <button type="button" class="btn ghost" data-action="open-pack">Receber pacote<small>planogramas ou imagens</small></button>
      <button type="button" class="btn" data-action="send-report" ${toSend ? '' : 'disabled'}>Enviar relatório<small>${toSend} execução(ões)</small></button>
    </div>
    <div class="filters">${filters
      .map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${ui.filter === k}">${label}</button>`)
      .join('')}</div>
    ${
      list
        .map((t) => {
          const c = compliance(t);
          return `<button type="button" class="card task-card" data-open="${esc(t.id)}">
          <div class="row"><div><h2>${t.unread ? '<span class="unread-dot" aria-label="novo"></span>' : ''}${esc(t.planogram.storeName)}</h2>
            <p>${esc(t.planogram.category)} · versão ${t.version} · ${t.planogram.fixture.bayCount} módulo(s)</p></div>
            <span class="chip ${t.status}">${STATUS[t.status]}</span></div>
          ${t.status === 'devolvido' && t.officeComment ? `<p style="color:var(--danger)">Devolvido: ${esc(t.officeComment)}</p>` : ''}
          <div class="progress"><i style="width:${(c.checked / Math.max(1, c.total)) * 100}%"></i></div>
          <p>${c.checked}/${c.total} posições conferidas · ${t.photos.length} foto(s) · recebido ${dateTime(t.receivedAt)}</p>
        </button>`;
        })
        .join('') || '<p class="hint" style="text-align:center;padding:2rem 0">Nada aqui.</p>'
    }
    <p class="hint" style="text-align:center">Promotor: ${esc(settings.promoter || 'não informado')} · <button type="button" class="link" data-action="rename">alterar</button></p>`;
}

// ---------- tarefa ----------

function showTask(id) {
  const t = taskById(id);
  if (t.unread) {
    t.unread = false;
    persist();
  }
  $('#view-home').hidden = true;
  $('#view-task').hidden = false;
  $('#back').hidden = false;
  $('#logo').hidden = true;
  $('#title').textContent = t.planogram.storeName;
  $('#subtitle').textContent = `${t.planogram.category} · versão ${t.version}`;
  ui.bay = Math.min(ui.bay, t.planogram.fixture.bayCount);
  renderTask(t);
  if (t.planogram.timeTracking && t.status === 'em_execucao') {
    timerHandle = setInterval(() => {
      const el = $('#timer');
      if (el) el.textContent = `⏱ ${formatDuration(durationMs(t))}`;
    }, 15000);
  }
}

// Produtos do planograma com a foto resolvida pela biblioteca do aparelho
// (pacotes antigos traziam a foto embutida em `image`).
function productsOf(t) {
  return t.planogram.products.map((p) => (p.imageKey && images[p.imageKey] ? { ...p, image: images[p.imageKey] } : p));
}

function productMap(t) {
  return new Map(productsOf(t).map((p) => [p.sku, p]));
}

const missingPhotos = (list) => missingImageKeys(list.map((t) => t.planogram), new Set(Object.keys(images))).length;

function matches(product, query) {
  if (!query) return false;
  const q = query.toLowerCase();
  return product.ean?.includes(q) || product.sku.toLowerCase().includes(q) || product.name.toLowerCase().includes(q);
}

function renderTask(t) {
  const c = compliance(t);
  const p = t.planogram;
  const bySku = productMap(t);
  const hit = ui.query ? p.products.find((x) => matches(x, ui.query)) : null;

  let action = '';
  if (t.status === 'novo' || t.status === 'devolvido') {
    action = `<button type="button" class="btn block" data-action="start">${t.status === 'devolvido' ? 'Refazer execução' : 'Iniciar execução'}</button>`;
  } else if (t.status === 'em_execucao') {
    action = `<button type="button" class="btn success block" data-action="finish">Concluir e salvar</button>`;
  }

  const head = `
    <div class="card status-card">
      <div class="row"><span class="chip ${t.status}">${STATUS[t.status]}</span>
        ${p.timeTracking && t.startedAt ? `<span class="timer" id="timer">⏱ ${formatDuration(durationMs(t))}</span>` : ''}</div>
      ${t.status === 'concluido' ? '<p class="hint">Concluído. Envie o relatório pelo botão na tela inicial e aguarde a revisão do escritório.</p>' : ''}
      ${t.status === 'aprovado' ? '<p class="hint">Execução aprovada pelo escritório.</p>' : ''}
      ${t.officeComment ? `<div class="note ${t.status === 'devolvido' ? 'danger' : ''}"><strong>Escritório:</strong> ${esc(t.officeComment)}</div>` : ''}
      ${p.note ? `<div class="note"><strong>Recado:</strong> ${esc(p.note)}</div>` : ''}
      <div class="progress-label"><span>${c.checked}/${c.total} conferidas</span><span>${c.problems} problema(s)</span></div>
      <div class="progress"><i style="width:${(c.checked / Math.max(1, c.total)) * 100}%"></i></div>
    </div>
    <div class="view-tabs" role="group" aria-label="Visualização">
      ${[
        ['drawing', 'Desenho'],
        ['list', 'Lista'],
        ['photos', `Fotos (${t.photos.length})`],
      ]
        .map(([k, label]) => `<button type="button" data-mode="${k}" aria-pressed="${ui.mode === k}">${label}</button>`)
        .join('')}
    </div>
    ${
      ui.mode !== 'photos'
        ? `<div class="search"><input type="search" id="search" placeholder="Buscar por EAN, SKU ou nome" value="${esc(ui.query)}" inputmode="search" aria-label="Buscar produto"></div>
           ${ui.query && !hit ? '<p class="hint">Produto não está neste planograma.</p>' : ''}`
        : ''
    }`;

  let body = '';
  if (ui.mode === 'drawing') {
    const bays = p.fixture.bayCount;
    body = `
      <div class="bay-bar">
        ${bays > 1 ? Array.from({ length: bays }, (_, i) => `<button type="button" class="btn ${ui.bay === i ? '' : 'ghost'} sm" data-bay="${i}">Módulo ${i + 1}</button>`).join('') + `<button type="button" class="btn ${ui.bay === bays ? '' : 'ghost'} sm" data-bay="${bays}">Todos</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="icon-btn" data-zoom="-1" aria-label="Diminuir">−</button>
        <button type="button" class="icon-btn" data-zoom="1" aria-label="Aumentar">+</button>
      </div>
      <div class="card drawing" id="drawing">${renderPlanogram({ ...p, blocks: [] }, productsOf(t), {
        rules: {},
        colorBy: 'brand',
        checks: t.checks,
        highlightSku: hit?.sku,
        bay: bays > 1 && ui.bay < bays ? ui.bay : null,
      })}</div>
      <p class="hint">Toque num produto para ver a ficha e conferir.</p>`;
  } else if (ui.mode === 'list') {
    body = p.shelves
      .map((shelf) => {
        const items = p.positions.filter((pos) => pos.shelf === shelf.index).sort((a, b) => a.x - b.x);
        if (items.length === 0) return '';
        return `<section class="card shelf-group">
          <header><strong><span class="badge">${shelf.index + 1}</span>Prateleira ${shelf.index + 1}</strong>
            ${editable(t) ? `<button type="button" class="link" data-shelf-ok="${shelf.index}">Tudo certo ✓</button>` : `<span class="muted">${items.length} itens</span>`}</header>
          ${items
            .map((pos, i) => {
              const prod = bySku.get(pos.sku);
              const check = t.checks[pos.id];
              return `<button type="button" class="item ${hit?.sku === pos.sku ? 'hit' : ''}" data-pos="${pos.id}">
                <span class="slot">${i + 1}</span>
                ${swatch(prod, t)}
                <span class="info"><strong>${esc(prod?.name ?? pos.sku)}</strong><small>${pos.facings} frente(s) · EAN ${esc(prod?.ean || '—')}</small></span>
                <span class="state ${check?.state ?? ''}">${check ? (check.state === 'ok' ? '✓' : '!') : ''}</span>
              </button>`;
            })
            .join('')}
        </section>`;
      })
      .join('');
  } else {
    body = `
      <div class="photos">
        ${t.photos.map((ph) => `<div class="photo"><img src="${esc(ph.dataUrl)}" alt="Foto da gôndola">${editable(t) ? `<button type="button" class="icon-btn" data-remove-photo="${ph.id}" aria-label="Remover foto">×</button>` : ''}</div>`).join('')}
        ${editable(t) ? '<label class="add-photo" for="photo-input"><div><span>+</span>Tirar foto</div></label>' : ''}
      </div>
      ${t.photos.length === 0 && !editable(t) ? '<p class="hint">Inicie a execução para tirar fotos.</p>' : ''}
      <label class="field"><span>Comentário para o escritório</span>
        <textarea id="comment" rows="3" ${editable(t) ? '' : 'disabled'} placeholder="Ex.: faltou produto no depósito">${esc(t.comment)}</textarea></label>`;
  }

  $('#view-task').innerHTML = `${head}${body}${action ? `<div class="bottom-bar"><div class="inner">${action}</div></div>` : ''}`;
  const svg = $('#drawing svg');
  if (svg) Object.assign(svg.style, { height: `${62 * ui.zoom}vh`, width: 'auto', maxWidth: 'none' });
  if (hit && ui.mode === 'drawing') $('#drawing .is-hit')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
}

function swatch(prod, t) {
  if (prod?.image) return `<img class="swatch" src="${esc(prod.image)}" alt="">`;
  const brands = [...new Set(t.planogram.products.map((p) => p.brand))];
  return `<span class="swatch" style="background:${colorFor(prod, 'brand', { brands })}"></span>`;
}

// ---------- ficha do produto ----------

function openSheet(taskId, posId) {
  ui.sheet = { taskId, posId, draft: null };
  renderSheet();
}

function closeSheet() {
  ui.sheet = null;
  $('#sheet-root').innerHTML = '';
}

function renderSheet() {
  const { taskId, posId, draft } = ui.sheet;
  const t = taskById(taskId);
  const pos = t.planogram.positions.find((x) => x.id === posId);
  const prod = productMap(t).get(pos.sku);
  const check = t.checks[posId];
  const problem = draft ?? (check?.state === 'problem' ? { issue: check.issue, note: check.note ?? '' } : null);

  $('#sheet-root').innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-label="Ficha do produto">
      <div class="grip"></div>
      <div class="head">${swatch(prod, t)}<div><h2>${esc(prod?.name ?? pos.sku)}</h2>
        <p class="hint" style="margin:.15rem 0">${esc(prod?.brand ?? '')} · ${esc(prod?.subcategory ?? '')}${prod?.price ? ` · R$ ${prod.price.toFixed(2).replace('.', ',')}` : ''}</p>
        <div class="ean">${esc(prod?.ean || 'sem EAN')}</div><small class="muted">SKU ${esc(pos.sku)}</small></div></div>
      <div class="where">
        <div><span>Prateleira</span><strong>${pos.shelf + 1}</strong></div>
        <div><span>Posição</span><strong>${slotIndex(t.planogram, pos)}º</strong></div>
        <div><span>Frentes</span><strong>${pos.facings}</strong></div>
      </div>
      <p class="hint" style="margin-top:-.4rem">${pos.high} na altura × ${pos.deep} na profundidade = ${pos.facings * pos.high * pos.deep} unidades. Contar da esquerda para a direita.</p>
      ${
        !editable(t)
          ? `<p class="hint">${t.status === 'novo' || t.status === 'devolvido' ? 'Toque em “Iniciar execução” para conferir.' : `Conferência: ${check ? (check.state === 'ok' ? 'certo' : ISSUES[check.issue]) : 'não conferido'}.`}</p>
             <button type="button" class="btn ghost block" data-close>Fechar</button>`
          : problem
            ? `<div class="issue-chips">${Object.entries(ISSUES)
                .map(([k, label]) => `<button type="button" data-issue="${k}" aria-pressed="${problem.issue === k}">${label}</button>`)
                .join('')}</div>
               <input type="text" id="issue-note" placeholder="Observação (opcional)" value="${esc(problem.note ?? '')}">
               <div class="actions" style="margin-top:.75rem">
                 <button type="button" class="btn ghost" data-action="cancel-problem">Cancelar</button>
                 <button type="button" class="btn danger" data-action="save-problem" ${problem.issue ? '' : 'disabled'}>Salvar problema</button>
               </div>`
            : `<div class="actions">
                 <button type="button" class="btn danger" data-action="problem">! Problema</button>
                 <button type="button" class="btn success" data-action="ok">✓ Está certo</button>
               </div>
               ${check ? '<button type="button" class="link" style="margin-top:.75rem" data-action="clear">Limpar conferência</button>' : ''}`
      }
    </div>`;
}

async function setCheck(t, posId, value) {
  if (value) t.checks[posId] = value;
  else delete t.checks[posId];
  await persist();
  renderTask(t);
}

function nextUnchecked(t, afterId) {
  const ordered = [...t.planogram.positions].sort((a, b) => a.shelf - b.shelf || a.x - b.x);
  const start = ordered.findIndex((p) => p.id === afterId);
  return [...ordered.slice(start + 1), ...ordered.slice(0, start)].find((p) => !t.checks[p.id]);
}

async function onSheetClick(e) {
  if (!ui.sheet) return;
  const el = e.target.closest('[data-close], [data-action], [data-issue]');
  if (!el) return;
  const t = taskById(ui.sheet.taskId);
  const { posId } = ui.sheet;
  if (el.dataset.close !== undefined) return closeSheet();
  if (el.dataset.issue) {
    ui.sheet.draft = { issue: el.dataset.issue, note: $('#issue-note')?.value ?? '' };
    return renderSheet();
  }
  switch (el.dataset.action) {
    case 'ok': {
      await setCheck(t, posId, { state: 'ok', at: new Date().toISOString() });
      // segue para a próxima posição sem conferência: agiliza a ronda
      const next = nextUnchecked(t, posId);
      if (next && ui.mode === 'list') openSheet(t.id, next.id);
      else closeSheet();
      break;
    }
    case 'problem':
      ui.sheet.draft = { issue: null, note: '' };
      renderSheet();
      break;
    case 'cancel-problem':
      ui.sheet.draft = null;
      if (t.checks[posId]?.state === 'problem') return closeSheet();
      renderSheet();
      break;
    case 'save-problem':
      await setCheck(t, posId, {
        state: 'problem',
        issue: ui.sheet.draft?.issue ?? t.checks[posId]?.issue,
        note: $('#issue-note').value.trim(),
        at: new Date().toISOString(),
      });
      closeSheet();
      break;
    case 'clear':
      await setCheck(t, posId, null);
      closeSheet();
      break;
  }
}

// ---------- ações ----------

async function importPack(file) {
  try {
    const data = await readJsonFile(file);
    if (packKind(data) === 'images') {
      const received = parseImagePack(data);
      images = { ...images, ...received };
      // guarda só as fotos que algum planograma do aparelho usa
      const used = new Set(tasks.flatMap((t) => t.planogram.products.map((p) => p.imageKey)));
      images = Object.fromEntries(Object.entries(images).filter(([k]) => used.has(k) || received[k]));
      await store.set('field.images', images);
      toast(`${Object.keys(received).length} foto(s) de produto recebida(s).`);
      route();
      return;
    }
    const pack = parsePack(data);
    const out = applyPack(tasks, pack);
    tasks = out.tasks;
    await persist();
    const s = out.summary;
    const parts = [s.added && `${s.added} novo(s)`, s.updated && `${s.updated} atualizado(s)`, s.reviewed && `${s.reviewed} revisão(ões)`].filter(Boolean);
    toast(parts.length ? `Pacote recebido: ${parts.join(', ')}.` : 'Nada novo neste pacote.');
    showHome();
  } catch (err) {
    toast(err.message);
  }
}

async function loadDemo() {
  const planograms = sampleStores.map((st) => {
    const inputs = localizeInputs({ products: sampleProducts, fixture: sampleFixture }, st);
    const plan = generatePlanogram({ ...inputs, rules: sampleRules, storeId: st.id });
    return publishPlanogram({
      store: st,
      category: sampleCategory,
      plan,
      products: inputs.products,
      version: 1,
      note: 'Demonstração: implantar e enviar uma foto da gôndola inteira.',
    });
  });
  tasks = applyPack(tasks, parsePack(JSON.parse(JSON.stringify(makePack({ planograms }))))).tasks;
  await persist();
  showHome();
}

async function sendReport() {
  if (!settings.promoter) {
    const name = prompt('Seu nome (vai no relatório):', '');
    if (name === null) return;
    settings.promoter = name.trim();
    await store.set('field.settings', settings);
  }
  const report = makeReport(tasks, settings.promoter);
  const day = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  try {
    await saveFile(`relatorio-${slug(settings.promoter || 'promotor')}-${day}.json`, JSON.stringify(report));
  } catch (err) {
    toast(`Não foi possível compartilhar: ${err.message ?? err}`);
  }
}

const slug = (s) => s.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

async function onTaskClick(e) {
  const id = decodeURIComponent(location.hash.split('/')[1] ?? '');
  const t = taskById(id);
  if (!t) return;
  const el = e.target.closest('[data-mode], [data-bay], [data-zoom], [data-action], [data-pos], [data-shelf-ok], [data-remove-photo], g.pos');
  if (!el) return;
  if (el.matches('g.pos')) return openSheet(t.id, el.dataset.id);
  if (el.dataset.pos) return openSheet(t.id, el.dataset.pos);
  if (el.dataset.mode) ui.mode = el.dataset.mode;
  else if (el.dataset.bay) ui.bay = Number(el.dataset.bay);
  else if (el.dataset.zoom) ui.zoom = Math.min(3, Math.max(0.6, ui.zoom + Number(el.dataset.zoom) * 0.3));
  else if (el.dataset.shelfOk) {
    const now = new Date().toISOString();
    for (const pos of t.planogram.positions.filter((p) => p.shelf === Number(el.dataset.shelfOk))) {
      if (!t.checks[pos.id]) t.checks[pos.id] = { state: 'ok', at: now };
    }
    await persist();
  } else if (el.dataset.removePhoto) {
    if (!confirm('Remover esta foto?')) return;
    t.photos = t.photos.filter((ph) => ph.id !== el.dataset.removePhoto);
    await persist();
  } else if (el.dataset.action === 'start') {
    t.status = 'em_execucao';
    t.startedAt = t.startedAt && t.officeComment ? t.startedAt : new Date().toISOString();
    t.finishedAt = null;
    await persist();
    return showTask(t.id);
  } else if (el.dataset.action === 'finish') {
    const c = compliance(t);
    const missing = c.total - c.checked;
    if (missing > 0 && !confirm(`Faltam ${missing} posição(ões) sem conferência. Concluir mesmo assim?`)) return;
    if (t.photos.length === 0 && !confirm('Nenhuma foto anexada. Concluir sem foto?')) return;
    t.status = 'concluido';
    t.finishedAt = new Date().toISOString();
    await persist();
    toast('Concluído. Envie o relatório na tela inicial.');
    clearInterval(timerHandle);
  }
  renderTask(t);
}

function wire() {
  $('#back').addEventListener('click', () => history.back());
  window.addEventListener('hashchange', route);
  $('#pack-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importPack(file);
  });
  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const t = taskById(decodeURIComponent(location.hash.split('/')[1] ?? ''));
    if (!file || !t) return;
    try {
      t.photos.push({ id: `f${Date.now()}`, dataUrl: await compressImage(file), takenAt: new Date().toISOString() });
      await persist();
      renderTask(t);
    } catch (err) {
      toast(err.message);
    }
  });
  $('#view-home').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action], [data-filter], [data-open]');
    if (!el) return;
    if (el.dataset.open) location.hash = `task/${encodeURIComponent(el.dataset.open)}`;
    else if (el.dataset.filter) {
      ui.filter = el.dataset.filter;
      showHome();
    } else if (el.dataset.action === 'open-pack') $('#pack-input').click();
    else if (el.dataset.action === 'demo') loadDemo();
    else if (el.dataset.action === 'send-report') sendReport();
    else if (el.dataset.action === 'rename') {
      const name = prompt('Seu nome (vai no relatório):', settings.promoter);
      if (name === null) return;
      settings.promoter = name.trim();
      await store.set('field.settings', settings);
      showHome();
    }
  });
  $('#view-task').addEventListener('click', onTaskClick);
  $('#view-task').addEventListener('input', async (e) => {
    const t = taskById(decodeURIComponent(location.hash.split('/')[1] ?? ''));
    if (!t) return;
    if (e.target.id === 'search') {
      ui.query = e.target.value.trim();
      clearTimeout(wire.searchTimer);
      wire.searchTimer = setTimeout(() => {
        renderTask(t);
        const input = $('#search');
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 250);
    } else if (e.target.id === 'comment') {
      t.comment = e.target.value;
      clearTimeout(wire.commentTimer);
      wire.commentTimer = setTimeout(persist, 400);
    }
  });
  $('#sheet-root').addEventListener('click', onSheetClick);
  $('#sheet-root').addEventListener('input', (e) => {
    if (e.target.id === 'issue-note' && ui.sheet?.draft) ui.sheet.draft.note = e.target.value;
  });
}

tasks = await store.get('field.tasks', []);
images = await store.get('field.images', {});
settings = { ...settings, ...(await store.get('field.settings', {})) };
wire();
route();

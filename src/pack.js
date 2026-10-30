// Troca de arquivos entre escritório e promotor (funciona sem servidor e sem internet):
//   escritório -> pacote (.json) com planogramas por loja, produtos e revisões
//   escritório -> pacote de imagens (.json), enviado à parte: as fotos pesam e mudam pouco
//   promotor   -> relatório (.json) com conferência, fotos e tempos de execução
// O arquivo vai por WhatsApp, e-mail, Drive ou cabo; o app guarda tudo no aparelho.

export const PACK_FORMAT = 'planogram-pack/v1';
export const REPORT_FORMAT = 'planogram-report/v1';
export const IMAGES_FORMAT = 'planogram-images/v1';

export const STATUS = {
  novo: 'Novo',
  em_execucao: 'Em execução',
  concluido: 'Concluído',
  devolvido: 'Devolvido',
  aprovado: 'Aprovado',
};

export const ISSUES = {
  ruptura: 'Ruptura',
  posicao: 'Posição errada',
  frentes: 'Frentes diferentes',
  preco: 'Preço / etiqueta',
  outro: 'Outro',
};

export const planogramId = (storeId, category) => `${storeId}::${category}`;

// Um planograma publicado leva os produtos que usa; a foto vai só como chave (imageKey),
// resolvida no aparelho pelo pacote de imagens.
export function publishPlanogram({ store, category, plan, products, version, note = '', timeTracking = true }) {
  const used = new Set(plan.positions.map((p) => p.sku));
  return {
    id: planogramId(store.id, category),
    storeId: store.id,
    storeName: store.name,
    category,
    version,
    publishedAt: new Date().toISOString(),
    note,
    timeTracking,
    fixture: plan.fixture,
    shelves: plan.shelves,
    positions: plan.positions.map(({ id, sku, shelf, x, width, facings, high, deep }) => ({
      id, sku, shelf, x, width, facings, high, deep,
    })),
    products: products
      .filter((p) => used.has(p.sku))
      .map(({ sku, ean, name, brand, subcategory, width, height, depth, price, imageKey }) => ({
        sku, ean, name, brand, subcategory, width, height, depth, price, imageKey: imageKey ?? '',
      })),
  };
}

export function makePack({ planograms, reviews = {}, from = 'Escritório' }) {
  return { format: PACK_FORMAT, createdAt: new Date().toISOString(), from, planograms, reviews };
}

export function makeImagePack(images) {
  return { format: IMAGES_FORMAT, createdAt: new Date().toISOString(), images };
}

export function parseImagePack(data) {
  if (data?.format !== IMAGES_FORMAT || typeof data.images !== 'object' || data.images === null) {
    throw new Error('Este arquivo não é um pacote de imagens.');
  }
  const images = {};
  for (const [key, url] of Object.entries(data.images)) {
    if (typeof url === 'string' && url.startsWith('data:image/')) images[key] = url;
  }
  return images;
}

// O app do promotor recebe os dois tipos de arquivo pelo mesmo botão.
export function packKind(data) {
  if (data?.format === PACK_FORMAT) return 'planograms';
  if (data?.format === IMAGES_FORMAT) return 'images';
  throw new Error('Arquivo não reconhecido: use o pacote de planogramas ou de imagens do escritório.');
}

// Chaves de imagem que os planogramas usam e o aparelho ainda não tem.
export function missingImageKeys(planograms, available) {
  const keys = new Set(planograms.flatMap((p) => p.products.map((x) => x.imageKey).filter(Boolean)));
  return [...keys].filter((k) => !available.has(k));
}

export function parsePack(data) {
  if (data?.format !== PACK_FORMAT) throw new Error('Este arquivo não é um pacote de planogramas.');
  if (!Array.isArray(data.planograms)) throw new Error('Pacote sem planogramas.');
  for (const p of data.planograms) {
    if (!p.id || !Array.isArray(p.positions) || !Array.isArray(p.shelves) || !Array.isArray(p.products)) {
      throw new Error(`Planograma inválido no pacote: ${p.id ?? '(sem id)'}`);
    }
  }
  return { planograms: data.planograms, reviews: data.reviews ?? {}, createdAt: data.createdAt };
}

export function newTask(planogram) {
  return {
    id: planogram.id,
    version: planogram.version,
    planogram,
    status: 'novo',
    unread: true,
    receivedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    checks: {},
    photos: [],
    comment: '',
    officeComment: '',
  };
}

// Aplica um pacote às tarefas do aparelho. Retorna as tarefas novas/alteradas e um resumo.
export function applyPack(tasks, pack) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const summary = { added: 0, updated: 0, reviewed: 0, ignored: 0 };
  for (const planogram of pack.planograms) {
    const current = byId.get(planogram.id);
    if (!current) {
      byId.set(planogram.id, newTask(planogram));
      summary.added++;
    } else if (planogram.version > current.version) {
      byId.set(planogram.id, newTask(planogram));
      summary.updated++;
    } else summary.ignored++;
  }
  for (const [id, review] of Object.entries(pack.reviews)) {
    const task = byId.get(id);
    if (!task || review.version !== task.version || !['aprovado', 'devolvido'].includes(review.status)) continue;
    if (task.status === review.status && task.officeComment === (review.comment ?? '')) continue;
    // devolvido: volta para execução mantendo o que já foi conferido
    byId.set(id, { ...task, status: review.status, officeComment: review.comment ?? '', unread: true });
    summary.reviewed++;
  }
  return { tasks: [...byId.values()], summary };
}

export function compliance(task) {
  const total = task.planogram.positions.length;
  const checks = Object.values(task.checks);
  const ok = checks.filter((c) => c.state === 'ok').length;
  const problems = checks.filter((c) => c.state === 'problem');
  const byIssue = {};
  for (const c of problems) byIssue[c.issue] = (byIssue[c.issue] ?? 0) + 1;
  return { total, checked: checks.length, ok, problems: problems.length, byIssue, rate: total ? ok / total : 0 };
}

export function durationMs(task) {
  if (!task.startedAt) return 0;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(task.startedAt));
}

export function makeReport(tasks, device = '') {
  return {
    format: REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    device,
    tasks: tasks
      .filter((t) => t.status !== 'novo')
      .map((t) => ({
        planogramId: t.id,
        version: t.version,
        storeId: t.planogram.storeId,
        storeName: t.planogram.storeName,
        category: t.planogram.category,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        durationMs: durationMs(t),
        // SKU e prateleira junto de cada conferência: o relatório se explica sozinho,
        // mesmo que o escritório já tenha republicado com outras posições
        checks: Object.fromEntries(
          Object.entries(t.checks).map(([id, c]) => {
            const pos = t.planogram.positions.find((p) => p.id === id);
            return [id, { ...c, sku: pos?.sku, shelf: pos?.shelf }];
          }),
        ),
        photos: t.photos,
        comment: t.comment,
        compliance: compliance(t),
      })),
  };
}

export function parseReport(data) {
  if (data?.format !== REPORT_FORMAT) throw new Error('Este arquivo não é um relatório de execução.');
  if (!Array.isArray(data.tasks)) throw new Error('Relatório sem tarefas.');
  return data;
}

// Escritório: guarda o relatório mais recente de cada planograma/versão.
export function mergeReports(existing, report) {
  const out = { ...existing };
  let merged = 0;
  for (const t of report.tasks) {
    const prev = out[t.planogramId];
    const newer =
      !prev || t.version > prev.version || (t.version === prev.version && (t.finishedAt ?? '') > (prev.finishedAt ?? ''));
    if (newer) {
      out[t.planogramId] = { ...t, receivedAt: new Date().toISOString(), device: report.device };
      merged++;
    }
  }
  return { reports: out, merged };
}

export const PHOTO_KINDS = { antes: 'Antes', depois: 'Depois' };

const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A virada só conta com foto do antes E do depois numa execução concluída (ou aprovada).
// A data é a da última foto do depois: o estado final da gôndola. Vale para tarefa e relatório.
export function viradaOf(execution) {
  const photos = execution?.photos ?? [];
  const antes = photos.filter((p) => p.kind === 'antes');
  const depois = photos.filter((p) => p.kind === 'depois');
  const missing = [!antes.length && 'antes', !depois.length && 'depois'].filter(Boolean);
  const done = ['concluido', 'aprovado'].includes(execution?.status);
  if (missing.length || !done) return { counted: false, missing, done };
  const last = depois.map((p) => p.takenAt).sort().at(-1);
  return { counted: true, date: localDate(last), at: last, missing: [], done };
}

export function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

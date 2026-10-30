// Cadastro de produtos: GTIN/EAN, planilha de medidas e associação de imagens pelo nome do arquivo.
// Tudo aqui é puro (sem DOM) para rodar nos testes.

// ---------- GTIN ----------

// Dígito verificador GS1 (vale para GTIN-8, 12, 13 e 14).
export function gtinCheckDigit(body) {
  const digits = [...String(body)].reverse();
  const sum = digits.reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}

export function ean13(base12) {
  const body = String(base12).padStart(12, '0').slice(-12);
  return body + gtinCheckDigit(body);
}

export function isValidGtin(code) {
  const s = String(code ?? '');
  return /^(\d{8}|\d{12,14})$/.test(s) && gtinCheckDigit(s.slice(0, -1)) === s.at(-1);
}

// Chave de comparação: GTIN-14 com zeros à esquerda (EAN-13 "789…" == GTIN-14 "0789…").
export function gtinKey(code) {
  const s = String(code ?? '').replace(/\D/g, '');
  return s.length >= 8 && s.length <= 14 ? s.padStart(14, '0') : '';
}

// ---------- planilha ----------

// Nomes de coluna aceitos (minúsculas, sem acento). O primeiro de cada lista é o do export.
const COLUMNS = {
  sku: ['sku', 'codigo interno', 'cod interno', 'codigo', 'id'],
  ean: ['ean', 'gtin', 'codigo de barras', 'cod barras', 'ean13', 'ean-13', 'barcode'],
  name: ['descricao', 'nome', 'produto', 'description', 'name'],
  brand: ['marca', 'fabricante', 'brand'],
  subcategory: ['subcategoria', 'categoria', 'segmento', 'subcategory'],
  width: ['larg', 'largura', 'frente', 'width', 'l'],
  height: ['alt', 'altura', 'height', 'a'],
  depth: ['prof', 'profundidade', 'depth', 'p'],
  weeklyUnits: ['un/semana', 'un semana', 'venda semanal', 'vendas semana', 'giro semanal', 'weeklyunits'],
  price: ['preco', 'preco (r$)', 'price'],
  margin: ['margem', 'margin'],
};
const NUMERIC = new Set(['width', 'height', 'depth', 'weeklyUnits', 'price', 'margin']);
const MEASURES = new Set(['width', 'height', 'depth']);

const simplify = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.:]/g, '')
    .trim();

// Descobre qual coluna é qual e em que unidade estão as medidas (cm, mm ou m).
export function mapColumns(headers) {
  const map = {};
  const parsed = headers.map((raw) => {
    const h = simplify(raw);
    const unit = /\(mm\)|\bmm\b/.test(h) ? 0.1 : /\(m\)/.test(h) ? 100 : 1;
    return { raw, base: h.replace(/\(.*?\)/g, '').trim(), unit, used: false };
  });
  // nome exato antes de prefixo: "código de barras" não pode cair em "código"
  for (const test of [(base, n) => base === n, (base, n) => n.length > 2 && base.startsWith(n)]) {
    for (const col of parsed) {
      if (col.used) continue;
      const field = Object.keys(COLUMNS).find((f) => !map[f] && COLUMNS[f].some((n) => test(col.base, n)));
      if (!field) continue;
      map[field] = { header: col.raw, scale: MEASURES.has(field) ? col.unit : 1 };
      col.used = true;
    }
  }
  return map;
}

const toNumber = (v) => {
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (s === '') return NaN;
  // "1.234,5" e "1234,5" (pt-BR) ou "1234.5"
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(normalized);
};

// Linhas da planilha -> produtos parciais (só os campos presentes), com erros por linha.
export function parseProductRecords(records) {
  if (records.length === 0) return { rows: [], errors: [], columns: {} };
  const columns = mapColumns(Object.keys(records[0]));
  const rows = [];
  const errors = [];
  records.forEach((rec, i) => {
    const line = i + 2; // linha 1 é o cabeçalho
    const p = {};
    for (const [field, { header, scale }] of Object.entries(columns)) {
      const raw = rec[header];
      if (raw === undefined || String(raw).trim() === '') continue;
      if (NUMERIC.has(field)) {
        const n = toNumber(raw) * scale;
        if (!Number.isFinite(n) || n < 0) {
          errors.push({ line, text: `${columns[field].header}: “${raw}” não é número` });
          continue;
        }
        p[field] = Math.round(n * 100) / 100;
      } else p[field] = String(raw).trim();
    }
    if (p.ean) {
      p.ean = p.ean.replace(/\D/g, '');
      if (!isValidGtin(p.ean)) errors.push({ line, text: `EAN ${p.ean} com dígito verificador inválido` });
    }
    if (!p.sku && !p.ean) {
      errors.push({ line, text: 'sem SKU nem EAN' });
      return;
    }
    for (const m of MEASURES) {
      if (p[m] === 0) errors.push({ line, text: `${m === 'width' ? 'largura' : m === 'height' ? 'altura' : 'profundidade'} zero` });
    }
    rows.push({ line, ...p });
  });
  return { rows, errors, columns };
}

const DEFAULTS = { brand: 'Sem marca', subcategory: 'Geral', weeklyUnits: 0, price: 0, margin: 0, imageKey: '', active: true };

// Atualiza pelo EAN (ou SKU) os produtos que já existem e cria os novos.
export function mergeProducts(existing, rows) {
  const out = existing.map((p) => ({ ...p }));
  const byEan = new Map(out.filter((p) => gtinKey(p.ean)).map((p) => [gtinKey(p.ean), p]));
  const bySku = new Map(out.map((p) => [p.sku, p]));
  const summary = { added: 0, updated: 0, incomplete: [] };
  for (const { line, ...row } of rows) {
    const target = (row.ean && byEan.get(gtinKey(row.ean))) || (row.sku && bySku.get(row.sku));
    if (target) {
      Object.assign(target, row);
      summary.updated++;
      continue;
    }
    const p = { ...DEFAULTS, sku: row.sku || row.ean, ean: '', name: row.name || row.sku || row.ean, ...row };
    out.push(p);
    if (p.ean) byEan.set(gtinKey(p.ean), p);
    bySku.set(p.sku, p);
    summary.added++;
    if (!(p.width > 0 && p.height > 0 && p.depth > 0)) {
      p.active = false; // sem medida não dá para planogramar
      summary.incomplete.push(p.sku);
    }
  }
  return { products: out, summary };
}

// ---------- imagens ----------

const FRONT_HINT = /(frente|frontal|front|_1\b|-1\b|_01\b)/i;
const SIDE_HINT = /(lado|lateral|side|topo|top|verso|back|costas)/i;

// "7891000100103_frente.png" -> "7891000100103"; aceita GTIN-8 a 14 em qualquer parte do nome.
export function codeFromFileName(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const digits = base.match(/\d{8,14}/g) ?? [];
  return { base, gtin: digits.find((d) => isValidGtin(d)) ?? '', digits };
}

// Associa arquivos a produtos: EAN no nome primeiro, depois SKU igual ao nome do arquivo.
export function matchImages(files, products) {
  const byEan = new Map(products.filter((p) => gtinKey(p.ean)).map((p) => [gtinKey(p.ean), p]));
  const bySku = new Map(products.map((p) => [simplify(p.sku), p]));
  const candidates = new Map(); // sku -> arquivos
  const unknown = [];
  for (const file of files) {
    const { base, gtin, digits } = codeFromFileName(file.name);
    if (SIDE_HINT.test(base) && !FRONT_HINT.test(base)) {
      unknown.push({ file, reason: 'Foto lateral/topo: o planograma usa só a frente' });
      continue;
    }
    const product = (gtin && byEan.get(gtinKey(gtin))) || bySku.get(simplify(base.replace(FRONT_HINT, '').replace(/[_-]+$/, '')));
    if (product) {
      if (!candidates.has(product.sku)) candidates.set(product.sku, []);
      candidates.get(product.sku).push(file);
    } else if (gtin) unknown.push({ file, reason: `EAN ${gtin} não está no cadastro` });
    else if (digits.length) unknown.push({ file, reason: `“${digits[0]}” não é um EAN válido (dígito verificador)` });
    else unknown.push({ file, reason: 'Nome do arquivo sem EAN nem SKU' });
  }
  const matched = [];
  for (const [sku, list] of candidates) {
    const product = products.find((p) => p.sku === sku);
    // várias fotos do mesmo produto: prefere a marcada como frente
    const sorted = [...list].sort((a, b) => Number(FRONT_HINT.test(b.name)) - Number(FRONT_HINT.test(a.name)));
    matched.push({ product, file: sorted[0], extra: sorted.slice(1) });
  }
  const withImage = new Set(matched.map((m) => m.product.sku));
  const missing = products.filter((p) => p.active !== false && !withImage.has(p.sku) && !p.imageKey);
  return { matched, unknown, missing };
}

// Compara a proporção da foto (já sem bordas) com largura × altura cadastradas.
export function ratioCheck(product, imgWidth, imgHeight) {
  if (!(product.width > 0 && product.height > 0 && imgWidth > 0 && imgHeight > 0)) return { level: 'unknown' };
  const expected = product.width / product.height;
  const actual = imgWidth / imgHeight;
  const diff = Math.abs(Math.log(actual / expected)); // simétrico: 2× e 0,5× pesam igual
  if (diff <= Math.log(1.2)) return { level: 'ok', expected, actual };
  const rotated = Math.abs(Math.log(actual / (1 / expected))) <= Math.log(1.2);
  return {
    level: diff <= Math.log(1.5) ? 'warn' : 'bad',
    expected,
    actual,
    rotated,
    text: rotated
      ? 'Foto deitada e medidas em pé (ou o contrário): largura e altura parecem trocadas'
      : `Proporção da foto ${actual.toFixed(2)} vs medidas ${expected.toFixed(2)}`,
  };
}

// Chave curta do conteúdo (FNV-1a 32 bits): muda quando a imagem muda.
export function contentHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const imageKeyFor = (product, dataUrl) => `${product.ean || product.sku}-${contentHash(dataUrl)}`;

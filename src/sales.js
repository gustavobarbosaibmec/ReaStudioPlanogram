// Venda da loja (sell-out) e comparação antes × depois da virada da gôndola. Puro, sem DOM.

import { gtinKey, mapColumns, simplify, toNumber } from './catalog.js';

const SALES_COLUMNS = {
  date: ['data', 'dia', 'data venda', 'date', 'dt'],
  store: ['loja', 'filial', 'cod loja', 'codigo loja', 'store', 'unidade'],
  ean: ['ean', 'gtin', 'codigo de barras', 'cod barras', 'barcode'],
  sku: ['sku', 'codigo interno', 'cod interno', 'codigo produto', 'produto', 'item'],
  units: ['quantidade', 'qtd', 'qtde', 'unidades', 'un', 'volume', 'units', 'qty'],
  revenue: ['valor', 'receita', 'faturamento', 'venda', 'venda (r$)', 'total', 'revenue', 'valor total'],
};

const pad = (n) => String(n).padStart(2, '0');

// "29/10/2026", "29-10-26", "2026-10-29", "2026-10-29T13:00" -> "2026-10-29"
export function parseDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) {
    [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Liga o código de loja da planilha/API à loja cadastrada (id, código na base ou nome).
export function storeResolver(stores) {
  const index = new Map();
  for (const st of stores) {
    for (const k of [st.id, st.code, st.name]) if (k) index.set(simplify(k), st.id);
  }
  return (value) => index.get(simplify(value ?? '')) ?? null;
}

// Linhas de planilha (ou já mapeadas de uma API) -> vendas normalizadas.
// `defaultStoreId` vale para arquivos sem coluna de loja.
export function parseSalesRecords(records, { stores = [], defaultStoreId = null, columns: given } = {}) {
  if (records.length === 0) return { rows: [], errors: [], columns: {} };
  const columns = given ?? mapColumns(Object.keys(records[0]), SALES_COLUMNS, new Set());
  const errors = [];
  const rows = [];
  const missing = ['date', 'units'].filter((f) => !columns[f]);
  if (!columns.ean && !columns.sku) missing.push('ean ou sku');
  if (missing.length) return { rows, errors: [{ line: 1, text: `Faltam colunas: ${missing.join(', ')}` }], columns };
  const resolve = storeResolver(stores);
  const unknownStores = new Set();
  records.forEach((rec, i) => {
    const line = i + 2;
    const get = (f) => (columns[f] ? rec[columns[f].header] : undefined);
    const date = parseDate(get('date'));
    if (!date) return errors.push({ line, text: `data inválida: “${get('date') ?? ''}”` });
    const units = toNumber(get('units'));
    if (!Number.isFinite(units)) return errors.push({ line, text: `quantidade inválida: “${get('units') ?? ''}”` });
    const revenue = columns.revenue ? toNumber(get('revenue')) : 0;
    let storeId = defaultStoreId;
    if (columns.store) {
      storeId = resolve(get('store'));
      if (!storeId) {
        unknownStores.add(String(get('store')));
        return;
      }
    }
    if (!storeId) return errors.push({ line, text: 'sem loja' });
    const ean = String(get('ean') ?? '').replace(/\D/g, '');
    const sku = String(get('sku') ?? '').trim();
    if (!ean && !sku) return errors.push({ line, text: 'sem EAN nem SKU' });
    rows.push({ storeId, date, ean, sku, units, revenue: Number.isFinite(revenue) ? revenue : 0 });
  });
  for (const code of unknownStores) errors.push({ line: 0, text: `Loja “${code}” não cadastrada (confira o código na base em Lojas)` });
  return { rows, errors, columns };
}

const productCode = (r) => gtinKey(r.ean) || `sku:${r.sku}`;

// Junta vendas novas às existentes: mesmo dia + mesmo produto substitui (reimportar não duplica).
export function mergeSales(existing, incoming) {
  const byKey = new Map(existing.map((r) => [`${r.date}|${productCode(r)}`, r]));
  let replaced = 0;
  // linhas repetidas no mesmo arquivo (várias vendas no dia) somam
  const fresh = new Map();
  for (const r of incoming) {
    const key = `${r.date}|${productCode(r)}`;
    const prev = fresh.get(key);
    fresh.set(key, prev ? { ...prev, units: prev.units + r.units, revenue: prev.revenue + r.revenue } : { ...r });
  }
  for (const [key, r] of fresh) {
    if (byKey.has(key)) replaced++;
    byKey.set(key, r);
  }
  return { rows: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date)), added: fresh.size - replaced, replaced };
}

function windowStats(rows, from, to) {
  const inside = rows.filter((r) => r.date >= from && r.date <= to);
  const days = new Set(inside.map((r) => r.date)).size;
  const calendarDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  const units = inside.reduce((a, r) => a + r.units, 0);
  const revenue = inside.reduce((a, r) => a + r.revenue, 0);
  return {
    from,
    to,
    calendarDays,
    daysWithData: days,
    coverage: days / calendarDays,
    units,
    revenue,
    // média por dia com venda: dia sem registro pode ser falta de dado, não venda zero
    unitsPerDay: days ? units / days : 0,
    revenuePerDay: days ? revenue / days : 0,
    rows: inside,
  };
}

const pctChange = (before, after) => (before > 0 ? after / before - 1 : null);

// Compara N dias antes da virada com N dias depois (o dia da virada fica de fora:
// a gôndola passou o dia sendo mexida). `products` define o escopo (a categoria).
export function compareTurnover(rows, viradaDate, { days = 28, products = [], onlyCatalog = true, today = null } = {}) {
  const byCode = new Map();
  for (const p of products) {
    if (gtinKey(p.ean)) byCode.set(gtinKey(p.ean), p);
    byCode.set(`sku:${p.sku}`, p);
  }
  const productOf = (r) => byCode.get(gtinKey(r.ean)) ?? byCode.get(`sku:${r.sku}`) ?? null;
  const scoped = onlyCatalog && products.length ? rows.filter((r) => productOf(r)) : rows;

  let afterTo = addDays(viradaDate, days);
  if (today && afterTo > today) afterTo = today;
  const before = windowStats(scoped, addDays(viradaDate, -days), addDays(viradaDate, -1));
  const after = afterTo > viradaDate ? windowStats(scoped, addDays(viradaDate, 1), afterTo) : windowStats([], addDays(viradaDate, 1), addDays(viradaDate, 1));

  const group = (keyOf, labelOf) => {
    const map = new Map();
    const add = (r, side) => {
      const key = keyOf(r);
      if (!map.has(key)) map.set(key, { key, label: labelOf(r), before: 0, after: 0, beforeRevenue: 0, afterRevenue: 0 });
      const g = map.get(key);
      g[side] += r.units;
      g[`${side}Revenue`] += r.revenue;
    };
    for (const r of before.rows) add(r, 'before');
    for (const r of after.rows) add(r, 'after');
    return [...map.values()].map((g) => {
      // compara médias diárias, porque as janelas podem ter dias com dado diferentes
      const b = before.daysWithData ? g.before / before.daysWithData : 0;
      const a = after.daysWithData ? g.after / after.daysWithData : 0;
      return { ...g, beforePerDay: b, afterPerDay: a, change: pctChange(b, a) };
    });
  };

  const bySku = group(productCode, (r) => productOf(r)?.name ?? (r.ean || r.sku)).sort(
    (x, y) => y.afterPerDay - y.beforePerDay - (x.afterPerDay - x.beforePerDay),
  );
  const bySubcategory = group(
    (r) => productOf(r)?.subcategory ?? 'Fora do cadastro',
    (r) => productOf(r)?.subcategory ?? 'Fora do cadastro',
  ).sort((x, y) => y.afterRevenue + y.beforeRevenue - (x.afterRevenue + x.beforeRevenue));

  const daily = new Map();
  for (const r of scoped) {
    if (r.date < before.from || r.date > after.to) continue;
    const d = daily.get(r.date) ?? { date: r.date, units: 0, revenue: 0 };
    d.units += r.units;
    d.revenue += r.revenue;
    daily.set(r.date, d);
  }

  const warnings = [];
  if (before.coverage < 0.8) warnings.push(`Só ${before.daysWithData} de ${before.calendarDays} dias com venda antes da virada.`);
  if (after.calendarDays < days) warnings.push(`A virada foi há ${after.calendarDays > 0 ? after.calendarDays : 0} dia(s): a janela depois ainda não fechou os ${days} dias.`);
  else if (after.coverage < 0.8) warnings.push(`Só ${after.daysWithData} de ${after.calendarDays} dias com venda depois da virada.`);

  const strip = ({ rows: _r, ...w }) => w;
  return {
    viradaDate,
    days,
    before: strip(before),
    after: strip(after),
    change: {
      units: pctChange(before.unitsPerDay, after.unitsPerDay),
      revenue: pctChange(before.revenuePerDay, after.revenuePerDay),
    },
    bySku,
    bySubcategory,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    warnings,
    scopedRows: scoped.length,
    totalRows: rows.length,
  };
}

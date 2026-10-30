// Indicadores e validação (conformidade) de um planograma, gerado ou editado à mão.

import { daysOfSupply, fixtureWidth, productWeight, unitsDeep, unitsHigh } from './engine.js';

const EPS = 1e-6;

export function evaluate(planogram, products, rules) {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const width = fixtureWidth(planogram.fixture);
  const issues = [];

  const rows = planogram.positions.map((pos) => {
    const product = bySku.get(pos.sku);
    const shelf = planogram.shelves[pos.shelf];
    if (!product || !shelf) {
      issues.push({ level: 'error', positionId: pos.id, text: `${pos.sku}: produto ou prateleira inexistente` });
      return { pos, product, capacity: 0 };
    }
    const high = unitsHigh(product, shelf.clearance, rules);
    if (high === 0) {
      issues.push({ level: 'error', positionId: pos.id, text: `${product.name}: não cabe na altura da prateleira ${pos.shelf + 1}` });
    }
    return { pos, product, capacity: pos.facings * high * unitsDeep(product, shelf.depth) };
  });

  // DOS é do SKU: soma a capacidade de todas as posições dele
  const skuCapacity = new Map();
  for (const r of rows) skuCapacity.set(r.pos.sku, (skuCapacity.get(r.pos.sku) ?? 0) + r.capacity);
  for (const r of rows) r.dos = r.product ? daysOfSupply(skuCapacity.get(r.pos.sku), r.product.weeklyUnits) : 0;
  const skus = [...skuCapacity].map(([sku, capacity]) => {
    const product = bySku.get(sku);
    return { sku, product, capacity, dos: product ? daysOfSupply(capacity, product.weeklyUnits) : 0 };
  });
  for (const s of skus) {
    if (s.product && s.capacity > 0 && s.dos < rules.minDos) {
      issues.push({
        level: 'warn',
        sku: s.sku,
        text: `${s.product.name}: ${s.dos.toFixed(1)} dias de estoque (mínimo ${rules.minDos})`,
      });
    }
  }

  for (const shelf of planogram.shelves) {
    const onShelf = planogram.positions.filter((p) => p.shelf === shelf.index).sort((a, b) => a.x - b.x);
    onShelf.forEach((pos, i) => {
      const name = bySku.get(pos.sku)?.name ?? pos.sku;
      if (pos.x < -EPS || pos.x + pos.width > width + EPS) {
        issues.push({ level: 'error', positionId: pos.id, text: `${name}: fora da gôndola` });
      }
      const prev = onShelf[i - 1];
      if (prev && pos.x < prev.x + prev.width - EPS) {
        issues.push({ level: 'error', positionId: pos.id, text: `${name}: sobrepõe outro produto na prateleira ${shelf.index + 1}` });
      }
    });
  }

  const placedSkus = new Set(planogram.positions.map((p) => p.sku));
  const missing = products.filter((p) => p.active !== false && !placedSkus.has(p.sku));
  for (const p of missing) {
    const reason = planogram.unplaced.find((u) => u.sku === p.sku)?.reason ?? 'Fora do planograma';
    issues.push({ level: 'warn', sku: p.sku, text: `${p.name}: ${reason}` });
  }

  const totalLinear = width * planogram.shelves.length;
  const usedLinear = planogram.positions.reduce((a, p) => a + p.width, 0);
  const finite = skus.filter((s) => Number.isFinite(s.dos) && s.capacity > 0);
  const avgDos = finite.length ? finite.reduce((a, s) => a + s.dos, 0) / finite.length : 0;

  return {
    rows,
    skus,
    issues,
    kpis: {
      skus: placedSkus.size,
      skusTotal: products.filter((p) => p.active !== false).length,
      facings: planogram.positions.reduce((a, p) => a + p.facings, 0),
      fill: totalLinear ? usedLinear / totalLinear : 0,
      usedLinear,
      totalLinear,
      avgDos,
      belowDos: skus.filter((s) => s.dos < rules.minDos).length,
      errors: issues.filter((i) => i.level === 'error').length,
    },
    spaceToSales: spaceToSales(planogram, products, rules, rows),
  };
}

// Participação no espaço vs participação nas vendas, no primeiro nível da árvore.
function spaceToSales(planogram, products, rules, rows) {
  const attribute = rules.blocking?.[0]?.attribute ?? 'subcategory';
  const groups = new Map();
  const add = (key, field, v) => {
    if (!groups.has(key)) groups.set(key, { key, space: 0, sales: 0 });
    groups.get(key)[field] += v;
  };
  for (const r of rows) if (r.product) add(r.product[attribute], 'space', r.pos.width);
  for (const p of products) if (p.active !== false) add(p[attribute], 'sales', productWeight(p, rules.spaceBasis));
  const space = [...groups.values()].reduce((a, g) => a + g.space, 0) || 1;
  const sales = [...groups.values()].reduce((a, g) => a + g.sales, 0) || 1;
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      spaceShare: g.space / space,
      salesShare: g.sales / sales,
      index: g.sales > 0 ? g.space / space / (g.sales / sales) : 0,
    }))
    .sort((a, b) => b.salesShare - a.salesShare);
}

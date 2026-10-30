// Motor de geração automática de planogramas.
//
// Fluxo (espelha o que a NIQ descreve publicamente para o Spaceman Automation):
//   1. árvore de decisão do shopper -> blocos (atributo, direção e sequência por nível)
//   2. espaço de cada bloco proporcional à base escolhida (unidades, receita, margem)
//   3. frentes por SKU a partir do alvo de dias de estoque (DOS), limitadas por mín./máx.
//   4. empacotamento em fluxo (prateleira de cima para baixo, esquerda para direita)
//   5. preenchimento do espaço que sobrou dando frentes a quem tem menor DOS
// Medidas em centímetros; vendas em unidades por semana.

const EPS = 1e-6;

export function buildShelves(fixture) {
  const { bayCount, bayWidth, height, baseHeight, shelfCount, shelfThickness, depth } = fixture;
  const pitch = (height - baseHeight) / shelfCount;
  const width = bayCount * bayWidth;
  const shelves = [];
  // índice 0 = prateleira superior, para seguir a ordem de fluxo
  for (let i = 0; i < shelfCount; i++) {
    const level = shelfCount - 1 - i;
    shelves.push({
      index: i,
      y: baseHeight + level * pitch + shelfThickness,
      clearance: pitch - shelfThickness,
      width,
      depth,
    });
  }
  return shelves;
}

export function fixtureWidth(fixture) {
  return fixture.bayCount * fixture.bayWidth;
}

export function productWeight(product, basis) {
  const units = Math.max(0, product.weeklyUnits);
  switch (basis) {
    case 'revenue':
      return units * product.price;
    case 'margin':
      return units * product.price * product.margin;
    case 'equal':
      return 1;
    default:
      return units;
  }
}

// Divide `total` proporcionalmente a `weights`, garantindo `mins` (water-filling).
export function allocate(total, weights, mins = weights.map(() => 0)) {
  const n = weights.length;
  if (n === 0) return [];
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum >= total - EPS) {
    return minSum === 0 ? weights.map(() => total / n) : mins.map((m) => (m / minSum) * total);
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const w = weightSum > 0 ? weights : weights.map(() => 1);
  const fixed = new Array(n).fill(false);
  const out = new Array(n).fill(0);
  for (;;) {
    const freeTotal = total - out.reduce((a, v, i) => a + (fixed[i] ? v : 0), 0);
    const freeWeight = w.reduce((a, v, i) => a + (fixed[i] ? 0 : v), 0);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const share = freeWeight > 0 ? (w[i] / freeWeight) * freeTotal : 0;
      if (share < mins[i] - EPS) {
        out[i] = mins[i];
        fixed[i] = true;
        changed = true;
      } else {
        out[i] = share;
      }
    }
    if (!changed) return out;
  }
}

// Versão inteira (maiores restos), usada para dividir prateleiras.
export function allocateInt(total, weights, mins) {
  const real = allocate(total, weights, mins);
  const out = real.map((v) => Math.floor(v + EPS));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = real.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return out;
}

const SEQUENCES = {
  'sales-desc': (a, b) => b.weight - a.weight,
  'sales-asc': (a, b) => a.weight - b.weight,
  alpha: (a, b) => String(a.key).localeCompare(String(b.key), 'pt-BR'),
};

function orderGroups(groups, level) {
  if (level.sequence === 'custom' && level.customOrder?.length) {
    const rank = (k) => {
      const i = level.customOrder.indexOf(k);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return groups.sort((a, b) => rank(a.key) - rank(b.key) || SEQUENCES['sales-desc'](a, b));
  }
  return groups.sort(SEQUENCES[level.sequence] ?? SEQUENCES['sales-desc']);
}

const PRODUCT_SEQUENCES = {
  'sales-desc': (a, b, basis) => productWeight(b, basis) - productWeight(a, basis),
  'height-desc': (a, b) => b.height - a.height,
  'size-asc': (a, b) => a.width * a.height - b.width * b.height,
  'price-asc': (a, b) => a.price - b.price,
  name: (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
};

export function sequenceProducts(products, rules) {
  const cmp = PRODUCT_SEQUENCES[rules.productSequence] ?? PRODUCT_SEQUENCES['sales-desc'];
  return [...products].sort((a, b) => cmp(a, b, rules.spaceBasis) || a.sku.localeCompare(b.sku));
}

// Agrupa recursivamente pelos níveis da árvore de decisão.
export function buildBlockTree(products, rules) {
  const levels = rules.blocking ?? [];
  const build = (items, depth, path) => {
    const weight = items.reduce((a, p) => a + productWeight(p, rules.spaceBasis), 0);
    if (depth >= levels.length) return { key: path.at(-1) ?? 'Todos', path, weight, products: sequenceProducts(items, rules) };
    const level = levels[depth];
    const byKey = new Map();
    for (const p of items) {
      const k = p[level.attribute] ?? '—';
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(p);
    }
    const children = orderGroups(
      [...byKey].map(([key, list]) => build(list, depth + 1, [...path, key])),
      level,
    );
    return { key: path.at(-1) ?? 'Todos', path, weight, children, level };
  };
  return build(products, 0, []);
}

export function unitsHigh(product, clearance, rules) {
  if (product.height > clearance + EPS) return 0;
  return rules.stacking ? Math.max(1, Math.floor((clearance + EPS) / product.height)) : 1;
}

export function unitsDeep(product, depth) {
  return Math.max(1, Math.floor((depth + EPS) / product.depth));
}

export function daysOfSupply(capacity, weeklyUnits) {
  return weeklyUnits > 0 ? capacity / (weeklyUnits / 7) : Infinity;
}

// Frentes necessárias para atingir o DOS alvo, limitadas pelas regras.
export function requiredFacings(product, shelf, rules) {
  const high = unitsHigh(product, shelf.clearance, rules);
  if (high === 0) return 0;
  const perFacing = high * unitsDeep(product, shelf.depth);
  const need = Math.ceil(((product.weeklyUnits / 7) * rules.targetDos) / perFacing);
  return clamp(need, minFacings(product, rules), maxFacings(product, rules));
}

function minFacings(product, rules) {
  return product.minFacings ?? rules.minFacings;
}

function maxFacings(product, rules) {
  return product.maxFacings ?? rules.maxFacings;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function minLinear(node, rules) {
  if (node.products) return node.products.reduce((a, p) => a + minFacings(p, rules) * p.width, 0);
  return node.children.reduce((a, c) => a + minLinear(c, rules), 0);
}

function widestUnit(node, rules) {
  if (node.products) return Math.max(0, ...node.products.map((p) => minFacings(p, rules) * p.width));
  return Math.max(0, ...node.children.map((c) => widestUnit(c, rules)));
}

function splitVertical(region, children, rules, snap, warnings) {
  const width = region.x1 - region.x0;
  const shelfCount = region.shelves.length;
  const mins = children.map((c) => Math.max(minLinear(c, rules) / shelfCount, widestUnit(c, rules)));
  const widths = allocate(width, children.map((c) => c.weight), mins);
  let bounds = [region.x0];
  for (const w of widths) bounds.push(bounds.at(-1) + w);
  bounds[bounds.length - 1] = region.x1;
  if (snap) {
    // "encaixa no limite de módulo mais próximo", como no assistente de automação
    const snapped = bounds.map((b, i) =>
      i === 0 || i === bounds.length - 1 ? b : region.x0 + Math.round((b - region.x0) / snap) * snap,
    );
    if (snapped.every((b, i) => i === 0 || b > snapped[i - 1] + EPS)) bounds = snapped;
    else warnings.push('Encaixe em módulos ignorado: algum bloco ficaria sem largura.');
  }
  return children.map((c, i) => ({ ...region, x0: bounds[i], x1: bounds[i + 1] }));
}

function splitHorizontal(region, children, rules, snap, warnings) {
  const count = region.shelves.length;
  if (children.length > count) {
    warnings.push(
      `Bloco horizontal com ${children.length} grupos e ${count} prateleiras: usado bloco vertical.`,
    );
    return splitVertical(region, children, rules, snap, warnings);
  }
  const width = region.x1 - region.x0;
  const mins = children.map((c) => Math.max(1, Math.ceil(minLinear(c, rules) / width - EPS)));
  const counts = allocateInt(count, children.map((c) => c.weight), mins);
  let start = 0;
  return children.map((c, i) => {
    const shelves = region.shelves.slice(start, start + counts[i]);
    start += counts[i];
    return { ...region, shelves };
  });
}

function assignRegions(node, region, rules, fixture, depth, out, warnings) {
  node.region = region;
  if (node.products) {
    out.push(node);
    return;
  }
  const snap = depth === 0 && rules.snapToBays ? fixture.bayWidth : 0;
  const split = node.level.direction === 'horizontal' ? splitHorizontal : splitVertical;
  const regions = split(region, node.children, rules, snap, warnings);
  node.children.forEach((child, i) => {
    if (regions[i].shelves.length === 0 || regions[i].x1 - regions[i].x0 <= EPS) {
      for (const p of leafProducts(child)) out.unplaced.push({ sku: p.sku, reason: 'Bloco sem espaço' });
      return;
    }
    assignRegions(child, regions[i], rules, fixture, depth + 1, out, warnings);
  });
}

function leafProducts(node) {
  return node.products ?? node.children.flatMap(leafProducts);
}

// Coloca os produtos de um bloco folha na sua região, em fluxo
// (prateleira de cima para baixo, esquerda para direita).
function packLeaf(leaf, shelves, rules, unplaced) {
  const { region } = leaf;
  const rows = region.shelves.map((i) => ({ shelf: shelves[i], items: [] }));
  const width = region.x1 - region.x0;
  const rowUsed = (row) => row.items.reduce((a, it) => a + it.facings * it.product.width, 0);
  // DOS do SKU somando todas as suas posições no bloco
  const itemDos = (it, shelf) => {
    const facings = rows.reduce(
      (a, row) => a + row.items.reduce((b, o) => b + (o.product === it.product ? o.facings : 0), 0),
      0,
    );
    return daysOfSupply(facings * capacityPerFacing(it.product, shelf, rules), it.product.weeklyUnits);
  };

  // vãos iguais em toda a gôndola: a primeira prateleira serve de referência
  const shelf = rows[0].shelf;
  const plan = [];
  for (const p of leaf.products) {
    if (unitsHigh(p, shelf.clearance, rules) === 0) {
      unplaced.push({ sku: p.sku, reason: 'Altura maior que o vão das prateleiras' });
    } else {
      plan.push({ product: p, facings: requiredFacings(p, shelf, rules) });
    }
  }
  if (plan.length === 0) return [];

  // Menos SKUs que prateleiras: os mais vendidos ganham uma segunda posição,
  // logo abaixo da original, para o bloco ocupar a altura inteira.
  const byWeight = [...plan].sort(
    (a, b) => productWeight(b.product, rules.spaceBasis) - productWeight(a.product, rules.spaceBasis),
  );
  for (let k = 0; plan.length < rows.length; k = (k + 1) % byWeight.length) {
    const original = byWeight[k];
    const copy = { product: original.product, facings: minFacings(original.product, rules) };
    plan.splice(plan.findLastIndex((i) => i.product === original.product) + 1, 0, copy);
  }

  // Divide a sequência entre as prateleiras, proporcional ao linear pedido.
  const need = (it) => it.facings * it.product.width;
  const perRow = plan.reduce((a, it) => a + need(it), 0) / rows.length;
  let r = 0;
  let cum = 0;
  plan.forEach((it, idx) => {
    const row = rows[r];
    if (row.items.length > 0 && r < rows.length - 1) {
      const forced = plan.length - idx <= rows.length - r - 1;
      const pastBoundary = cum + need(it) / 2 > perRow * (r + 1);
      const noRoom = rowUsed(row) + minFacings(it.product, rules) * it.product.width > width + EPS;
      if (forced || pastBoundary || noRoom) r++;
    }
    rows[r].items.push(it);
    cum += need(it);
  });

  for (const row of rows) {
    // Excesso: tira frentes de quem tem maior DOS; se não der, o último sai.
    while (rowUsed(row) > width + EPS) {
      const reducible = row.items.filter((it) => it.facings > minFacings(it.product, rules));
      if (reducible.length > 0) {
        reducible.sort((a, b) => itemDos(b, row.shelf) - itemDos(a, row.shelf))[0].facings--;
      } else {
        row.items.pop();
      }
    }
    // Sobra: uma frente por vez para o SKU com menor DOS.
    for (;;) {
      const free = width - rowUsed(row);
      const candidates = row.items.filter(
        (it) => it.product.width <= free + EPS && it.facings < maxFacings(it.product, rules),
      );
      if (candidates.length === 0) break;
      candidates.sort((a, b) => itemDos(a, row.shelf) - itemDos(b, row.shelf))[0].facings++;
    }
  }

  const placed = new Set(rows.flatMap((row) => row.items.map((it) => it.product)));
  for (const it of plan) {
    if (placed.has(it.product)) continue;
    placed.add(it.product);
    unplaced.push({ sku: it.product.sku, reason: 'Sem espaço no bloco' });
  }

  return rows.flatMap((row) => {
    let x = region.x0;
    return row.items.map((it) => {
      const position = makePosition(it.product, row.shelf, x, it.facings, leaf.path, rules);
      x += position.width;
      return position;
    });
  });
}

export function capacityPerFacing(product, shelf, rules) {
  return unitsHigh(product, shelf.clearance, rules) * unitsDeep(product, shelf.depth);
}

let nextId = 0;
export function makePosition(product, shelf, x, facings, blockPath, rules) {
  return {
    id: `pos-${++nextId}-${Math.random().toString(36).slice(2, 7)}`,
    sku: product.sku,
    shelf: shelf.index,
    x,
    width: facings * product.width,
    facings,
    high: unitsHigh(product, shelf.clearance, rules),
    deep: unitsDeep(product, shelf.depth),
    blockPath,
  };
}

export function generatePlanogram({ products, fixture, rules, storeId = null }) {
  const shelves = buildShelves(fixture);
  const width = fixtureWidth(fixture);
  const warnings = [];
  const leaves = [];
  leaves.unplaced = [];
  const active = products.filter((p) => p.active !== false);
  const tree = buildBlockTree(active, rules);
  const fullRegion = { shelves: shelves.map((s) => s.index), x0: 0, x1: width };
  assignRegions(tree, fullRegion, rules, fixture, 0, leaves, warnings);

  const unplaced = [...leaves.unplaced];
  const positions = leaves.flatMap((leaf) => packLeaf(leaf, shelves, rules, unplaced));
  const blocks = leaves.map((leaf) => ({
    path: leaf.path,
    x0: leaf.region.x0,
    x1: leaf.region.x1,
    shelves: leaf.region.shelves,
  }));
  return { storeId, fixture: { ...fixture }, shelves, positions, blocks, unplaced, warnings };
}

// Loja: módulos próprios, índice de venda por subcategoria e SKUs fora do sortimento.
export function localizeInputs({ products, fixture }, store) {
  if (!store) return { products, fixture };
  const delisted = new Set(store.delisted ?? []);
  return {
    fixture: { ...fixture, bayCount: store.bayCount ?? fixture.bayCount },
    products: products
      .filter((p) => !delisted.has(p.sku))
      .map((p) => ({ ...p, weeklyUnits: p.weeklyUnits * (store.salesIndex?.[p.subcategory] ?? 1) })),
  };
}

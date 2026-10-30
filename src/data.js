// Dados de exemplo (fictícios): categoria Biscoitos. Medidas em cm, vendas em unidades/semana.

import { ean13 } from './catalog.js';

const row = (sku, name, brand, subcategory, width, height, depth, weeklyUnits, price, margin) => ({
  sku, ean: ean13(`7891000${sku.slice(-5)}`), name, brand, subcategory, width, height, depth, weeklyUnits, price, margin,
  imageKey: '', active: true,
});

export const sampleProducts = [
  row('7890001', 'Recheado Chocolate 130g', 'Crocante', 'Recheado', 6, 14, 4.5, 84, 3.49, 0.28),
  row('7890002', 'Recheado Morango 130g', 'Crocante', 'Recheado', 6, 14, 4.5, 52, 3.49, 0.28),
  row('7890003', 'Recheado Baunilha 130g', 'Crocante', 'Recheado', 6, 14, 4.5, 31, 3.49, 0.28),
  row('7890004', 'Recheado Duplo Choc. 130g', 'Vovó Lia', 'Recheado', 6.2, 14.5, 4.5, 47, 3.99, 0.31),
  row('7890005', 'Recheado Limão 130g', 'Vovó Lia', 'Recheado', 6.2, 14.5, 4.5, 22, 3.99, 0.31),
  row('7890006', 'Recheado Chocolate 90g', 'Marca Própria', 'Recheado', 5.5, 12, 4, 38, 2.29, 0.38),
  row('7890007', 'Recheado Morango 90g', 'Marca Própria', 'Recheado', 5.5, 12, 4, 19, 2.29, 0.38),
  row('7890011', 'Água e Sal 350g', 'Bom Trigo', 'Água e Sal', 9, 19, 6, 41, 5.29, 0.24),
  row('7890012', 'Água e Sal Integral 350g', 'Bom Trigo', 'Água e Sal', 9, 19, 6, 17, 5.79, 0.26),
  row('7890013', 'Cream Cracker 400g', 'Crocante', 'Água e Sal', 9.5, 20, 6.5, 36, 5.49, 0.25),
  row('7890014', 'Cream Cracker Integral 400g', 'Crocante', 'Água e Sal', 9.5, 20, 6.5, 12, 5.99, 0.26),
  row('7890015', 'Água e Sal 200g', 'Marca Própria', 'Água e Sal', 7, 15, 5, 26, 3.19, 0.36),
  row('7890021', 'Maria 200g', 'Vovó Lia', 'Maria e Maisena', 6.5, 16, 5, 33, 3.29, 0.27),
  row('7890022', 'Maisena 200g', 'Vovó Lia', 'Maria e Maisena', 6.5, 16, 5, 29, 3.29, 0.27),
  row('7890023', 'Maria 350g', 'Bom Trigo', 'Maria e Maisena', 8, 18, 5.5, 21, 4.89, 0.24),
  row('7890024', 'Maisena Leite 350g', 'Bom Trigo', 'Maria e Maisena', 8, 18, 5.5, 14, 4.89, 0.24),
  row('7890025', 'Maria 170g', 'Marca Própria', 'Maria e Maisena', 6, 15, 4.5, 18, 2.49, 0.37),
  row('7890031', 'Wafer Chocolate 115g', 'Doce Vale', 'Wafer', 5, 17, 3, 44, 2.99, 0.3),
  row('7890032', 'Wafer Morango 115g', 'Doce Vale', 'Wafer', 5, 17, 3, 27, 2.99, 0.3),
  row('7890033', 'Wafer Limão 115g', 'Doce Vale', 'Wafer', 5, 17, 3, 15, 2.99, 0.3),
  row('7890034', 'Wafer Chocolate 140g', 'Crocante', 'Wafer', 5.5, 18, 3.2, 30, 3.39, 0.29),
  row('7890035', 'Wafer Avelã 140g', 'Crocante', 'Wafer', 5.5, 18, 3.2, 11, 3.69, 0.32),
  row('7890041', 'Cookies Gotas Choc. 120g', 'Doce Vale', 'Cookies', 12, 15, 4, 28, 4.49, 0.33),
  row('7890042', 'Cookies Aveia 120g', 'Doce Vale', 'Cookies', 12, 15, 4, 13, 4.49, 0.33),
  row('7890043', 'Cookies Integral 150g', 'Vovó Lia', 'Cookies', 12.5, 16, 4.5, 16, 5.19, 0.34),
  row('7890044', 'Cookies Baunilha 100g', 'Marca Própria', 'Cookies', 11, 14, 4, 12, 2.99, 0.39),
];

export const sampleFixture = {
  bayCount: 2,
  bayWidth: 100,
  height: 180,
  depth: 45,
  baseHeight: 15,
  shelfCount: 5,
  shelfThickness: 2,
};

export const sampleRules = {
  blocking: [
    { attribute: 'subcategory', direction: 'vertical', sequence: 'sales-desc', customOrder: [] },
    { attribute: 'brand', direction: 'horizontal', sequence: 'sales-desc', customOrder: [] },
  ],
  productSequence: 'sales-desc',
  spaceBasis: 'units',
  targetDos: 7,
  minDos: 3,
  minFacings: 1,
  maxFacings: 10,
  stacking: true,
  snapToBays: false,
};

export const sampleCategory = 'Biscoitos';

export const sampleStores = [
  { id: 'L01', name: 'Loja 01 · Centro', bayCount: 2, salesIndex: {}, delisted: [] },
  {
    id: 'L02',
    name: 'Loja 02 · Bairro',
    bayCount: 1,
    salesIndex: { Recheado: 1.3, 'Água e Sal': 0.8, Cookies: 0.6 },
    delisted: ['7890014', '7890035', '7890042'],
  },
  {
    id: 'L03',
    name: 'Loja 03 · Atacarejo',
    bayCount: 3,
    salesIndex: { 'Água e Sal': 1.6, 'Maria e Maisena': 1.4, Wafer: 0.9 },
    delisted: [],
  },
];

export const BRAND_COLORS = {
  Crocante: '#c2410c',
  'Vovó Lia': '#7c3aed',
  'Doce Vale': '#db2777',
  'Bom Trigo': '#ca8a04',
  'Marca Própria': '#0f766e',
};

export const PRODUCT_FIELDS = [
  ['sku', 'SKU', 'text'],
  ['ean', 'EAN', 'text'],
  ['name', 'Descrição', 'text'],
  ['brand', 'Marca', 'text'],
  ['subcategory', 'Subcategoria', 'text'],
  ['width', 'Larg. (cm)', 'number'],
  ['height', 'Alt. (cm)', 'number'],
  ['depth', 'Prof. (cm)', 'number'],
  ['weeklyUnits', 'Un./semana', 'number'],
  ['price', 'Preço (R$)', 'number'],
  ['margin', 'Margem (0–1)', 'number'],
];

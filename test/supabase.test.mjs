// Roda a migração num Postgres local (PGlite) com o mínimo do Supabase simulado
// (auth.users, auth.uid(), storage) e confere as regras de acesso por papel.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { before, test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text, owner uuid
  );
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

const ADA = '00000000-0000-4000-8000-00000000000a'; // admin
const BETO = '00000000-0000-4000-8000-00000000000b'; // promotor
const CAIO = '00000000-0000-4000-8000-00000000000c'; // de fora

let db;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(`insert into auth.users values
    ('${ADA}', 'ada@exemplo.com'), ('${BETO}', 'beto@exemplo.com'), ('${CAIO}', 'caio@exemplo.com')`);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'));
});

// Executa como a pessoa logada (ou anônimo), como o PostgREST faz em cada pedido.
async function as(uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    await tx.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
    return (await tx.query(sql, params)).rows;
  });
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, err.message);
    return true;
  });
}

const store = (id, name) => ({ id, name, code: id, bayCount: 2 });
const product = (sku, ean) => ({ sku, ean, name: `Produto ${sku}`, width: 5, height: 20, depth: 5 });
const save = (uid, org, expected, { data = {}, stores = [], products = [], publication = null } = {}) =>
  as(uid, 'select public.save_workspace($1, $2, $3, $4, $5, $6) as revision', [
    org,
    expected,
    JSON.stringify(data),
    JSON.stringify(stores),
    JSON.stringify(products),
    publication && JSON.stringify(publication),
  ]).then((rows) => Number(rows[0].revision));

let org;

test('quem cria a empresa vira administrador e o projeto começa na revisão 0', async () => {
  [{ id: org }] = await as(ADA, `select public.create_organization('Distribuidora Teste') as id`);
  assert.deepEqual(await as(ADA, 'select role, display_name from public.memberships where org_id = $1', [org]), [
    { role: 'admin', display_name: 'ada@exemplo.com' },
  ]);
  const [{ w }] = await as(ADA, 'select public.load_workspace($1) as w', [org]);
  assert.equal(w.revision, 0);
  assert.equal(w.publication, null);
  assert.deepEqual(w.stores, []);
});

test('gravar exige a revisão lida e guarda tudo na ordem da tela', async () => {
  const publication = {
    version: 1,
    publishedAt: '2026-10-31T12:00:00.000Z',
    note: 'nova gôndola',
    timeTracking: true,
    planograms: [
      { id: 'L01::Biscoitos', storeId: 'L01', positions: [] },
      { id: 'L02::Biscoitos', storeId: 'L02', positions: [] },
    ],
  };
  const payload = {
    data: { category: 'Biscoitos', rules: { maxFacings: 10 } },
    stores: [store('L02', 'Centro'), store('L01', 'Bairro')],
    products: [product('B2', '7891000100103'), product('A1', '')],
    publication,
  };
  assert.equal(await save(ADA, org, 0, payload), 1);
  await rejects(save(ADA, org, 0, payload), 'PT409');

  const [{ w }] = await as(ADA, 'select public.load_workspace($1) as w', [org]);
  assert.equal(w.revision, 1);
  assert.deepEqual(w.data, payload.data);
  assert.deepEqual(w.stores.map((s) => s.id), ['L02', 'L01']);
  assert.deepEqual(w.products.map((p) => p.sku), ['B2', 'A1']);
  assert.equal(w.publication.version, 1);
  assert.deepEqual(w.publication.planograms.map((p) => p.id), ['L01::Biscoitos', 'L02::Biscoitos']);

  // tirar uma loja e um produto do cadastro apaga só eles; a versão publicada não muda
  const next = { ...payload, stores: [store('L01', 'Bairro')], products: [product('A1', '')] };
  assert.equal(await save(ADA, org, 1, { ...next, publication: { ...publication, note: 'outra' } }), 2);
  const [{ w: w2 }] = await as(ADA, 'select public.load_workspace($1) as w', [org]);
  assert.deepEqual(w2.stores.map((s) => s.id), ['L01']);
  assert.deepEqual(w2.products.map((p) => p.sku), ['A1']);
  assert.equal(w2.publication.note, 'nova gôndola');
});

test('quem não é da empresa não vê nem grava nada', async () => {
  assert.deepEqual(await as(CAIO, 'select * from public.organizations'), []);
  assert.deepEqual(await as(CAIO, 'select * from public.products'), []);
  assert.deepEqual(await as(CAIO, 'select * from public.planograms'), []);
  await rejects(as(CAIO, 'select public.load_workspace($1)', [org]), 'PT403');
  await rejects(save(CAIO, org, 2), 'PT403');
  await rejects(as(CAIO, `select public.add_member($1, 'caio@exemplo.com', 'admin')`, [org]), 'PT403');
  // insert direto também é barrado pela regra de acesso
  await rejects(as(CAIO, `insert into public.products (org_id, sku, data) values ($1, 'X', '{}')`, [org]), '42501');
});

test('sem login não há acesso às tabelas', async () => {
  await rejects(as(null, 'select * from public.products'), '42501');
  await rejects(as(null, `select public.create_organization('x')`), '42501');
});

test('promotor vê produtos e só os planogramas das lojas atribuídas', async () => {
  await rejects(as(ADA, `select public.add_member($1, 'ninguem@exemplo.com', 'promoter')`, [org]), 'PT404');
  await as(ADA, `select public.add_member($1, 'Beto@Exemplo.com', 'promoter', 'Beto')`, [org]);
  await as(ADA, `insert into public.store_assignments values ($1, 'L01', $2)`, [org, BETO]);

  assert.equal((await as(BETO, 'select * from public.products')).length, 1);
  assert.deepEqual((await as(BETO, 'select id from public.stores')).map((r) => r.id), ['L01']);
  assert.deepEqual((await as(BETO, 'select store_id from public.planograms')).map((r) => r.store_id), ['L01']);
  assert.deepEqual(await as(BETO, 'select * from public.workspaces'), []);
  await rejects(as(BETO, 'select public.load_workspace($1)', [org]), 'PT403');
  await rejects(save(BETO, org, 2), 'PT403');
  await rejects(as(BETO, `insert into public.store_assignments values ($1, 'L01', $2)`, [org, BETO]), '42501');
  await rejects(as(BETO, `select public.add_member($1, 'beto@exemplo.com', 'admin')`, [org]), 'PT403');
});

test('a equipe só muda pelo administrador, que não se remove', async () => {
  await rejects(as(ADA, 'select public.remove_member($1, $2)', [org, ADA]), 'PT409');
  await rejects(as(ADA, `select public.add_member($1, 'ada@exemplo.com', 'office')`, [org]), 'PT409');
  await rejects(as(BETO, `update public.memberships set role = 'admin' where user_id = $1`, [BETO]), '42501');
  await as(ADA, 'select public.remove_member($1, $2)', [org, BETO]);
  assert.deepEqual(await as(BETO, 'select * from public.products'), []);
  // a atribuição de loja sai junto com a pessoa
  assert.deepEqual(await as(ADA, 'select * from public.store_assignments'), []);
});

test('imagens de produto ficam na pasta da empresa', async () => {
  const name = `${org}/7891000100103-abc`;
  await as(ADA, `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [name]);
  await rejects(
    as(CAIO, `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [`${org}/intruso`]),
    '42501',
  );
  // nome fora do padrão <empresa>/<arquivo> não é de ninguém e não quebra a leitura
  await db.exec(`insert into storage.objects (bucket_id, name) values ('product-images', 'solto.webp')`);
  assert.deepEqual((await as(ADA, 'select name from storage.objects')).map((r) => r.name), [name]);
  assert.deepEqual(await as(CAIO, 'select name from storage.objects'), []);
});

-- Fase 1 da nuvem: empresas, equipe, lojas, produtos, projeto do escritório,
-- versões publicadas e imagens dos produtos.
-- Rode uma vez no SQL Editor do Supabase (ou `supabase db push`).
--
-- Papéis: admin (gerencia a equipe), office (planeja e publica), promoter (campo).
-- Toda leitura e escrita passa pelas regras de acesso (RLS) abaixo: a chave pública
-- do app só enxerga o que o login da pessoa permite.

-- ---------- tabelas ----------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('admin', 'office', 'promoter')),
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- data guarda a loja como o Studio a usa; position mantém a ordem da tela.
create table public.stores (
  org_id uuid not null references public.organizations on delete cascade,
  id text not null check (length(id) between 1 and 80),
  position int not null default 0,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, id)
);

create table public.store_assignments (
  org_id uuid not null,
  store_id text not null,
  user_id uuid not null,
  primary key (org_id, store_id, user_id),
  foreign key (org_id, store_id) references public.stores on delete cascade,
  foreign key (org_id, user_id) references public.memberships on delete cascade
);
create index store_assignments_user_idx on public.store_assignments (user_id);

create table public.products (
  org_id uuid not null references public.organizations on delete cascade,
  sku text not null check (length(sku) between 1 and 80),
  ean text not null default '',
  position int not null default 0,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, sku)
);
create index products_ean_idx on public.products (org_id, ean) where ean <> '';

-- Projeto de trabalho do escritório (gôndola, regras, planograma em edição, revisões).
-- revision cresce a cada gravação: quem grava diz qual revisão leu, e a gravação
-- falha se outra pessoa gravou antes (ninguém sobrescreve o trabalho do outro sem ver).
create table public.workspaces (
  org_id uuid primary key references public.organizations on delete cascade,
  revision bigint not null default 0,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);

-- Versões publicadas não mudam depois de gravadas.
create table public.publications (
  org_id uuid not null references public.organizations on delete cascade,
  version int not null check (version > 0),
  published_at timestamptz not null,
  published_by uuid references auth.users on delete set null,
  note text not null default '',
  time_tracking boolean not null default true,
  primary key (org_id, version)
);

-- Um planograma por loja e versão. Sem chave para stores de propósito: o histórico
-- publicado continua existindo se a loja sair do cadastro.
create table public.planograms (
  org_id uuid not null,
  version int not null,
  id text not null,
  store_id text not null,
  data jsonb not null,
  primary key (org_id, version, id),
  foreign key (org_id, version) references public.publications on delete cascade
);
create index planograms_store_idx on public.planograms (org_id, store_id, version desc);

-- ---------- quem é quem ----------
-- security definer: leem memberships sem passar pelas regras dela (evita recursão).

create function public.member_role(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.memberships where org_id = p_org and user_id = auth.uid()
$$;

create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships where org_id = p_org and user_id = auth.uid())
$$;

create function public.is_office(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships
    where org_id = p_org and user_id = auth.uid() and role in ('admin', 'office')
  )
$$;

create function public.assigned_to_store(p_org uuid, p_store text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.store_assignments
    where org_id = p_org and store_id = p_store and user_id = auth.uid()
  )
$$;

-- Arquivos do Storage ficam em <empresa>/<arquivo>; nome fora desse padrão não pertence a ninguém.
create function public.org_of_object(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

-- ---------- regras de acesso ----------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.stores enable row level security;
alter table public.store_assignments enable row level security;
alter table public.products enable row level security;
alter table public.workspaces enable row level security;
alter table public.publications enable row level security;
alter table public.planograms enable row level security;

create policy "membros veem a empresa" on public.organizations
  for select to authenticated using (public.is_member(id));
create policy "admin renomeia a empresa" on public.organizations
  for update to authenticated using (public.member_role(id) = 'admin') with check (public.member_role(id) = 'admin');

-- a equipe muda só pelas funções add_member/remove_member
create policy "membros veem a equipe" on public.memberships
  for select to authenticated using (public.is_member(org_id));

create policy "escritório vê todas as lojas, promotor as suas" on public.stores
  for select to authenticated using (public.is_office(org_id) or public.assigned_to_store(org_id, id));
create policy "escritório altera lojas" on public.stores
  for all to authenticated using (public.is_office(org_id)) with check (public.is_office(org_id));

create policy "escritório vê as atribuições, promotor as suas" on public.store_assignments
  for select to authenticated using (public.is_office(org_id) or user_id = auth.uid());
create policy "escritório atribui lojas" on public.store_assignments
  for all to authenticated using (public.is_office(org_id)) with check (public.is_office(org_id));

create policy "membros veem os produtos" on public.products
  for select to authenticated using (public.is_member(org_id));
create policy "escritório altera produtos" on public.products
  for all to authenticated using (public.is_office(org_id)) with check (public.is_office(org_id));

create policy "escritório usa o projeto" on public.workspaces
  for all to authenticated using (public.is_office(org_id)) with check (public.is_office(org_id));

create policy "membros veem as versões" on public.publications
  for select to authenticated using (public.is_member(org_id));
create policy "escritório publica" on public.publications
  for insert to authenticated with check (public.is_office(org_id));

create policy "escritório vê os planogramas, promotor os das suas lojas" on public.planograms
  for select to authenticated using (public.is_office(org_id) or public.assigned_to_store(org_id, store_id));
create policy "escritório grava planogramas publicados" on public.planograms
  for insert to authenticated with check (public.is_office(org_id));

revoke all on public.organizations, public.memberships, public.stores, public.store_assignments,
  public.products, public.workspaces, public.publications, public.planograms from anon;
grant select on public.organizations, public.memberships, public.publications, public.planograms to authenticated;
grant update (name) on public.organizations to authenticated;
grant insert on public.publications, public.planograms to authenticated;
grant select, insert, update, delete on public.stores, public.store_assignments, public.products, public.workspaces
  to authenticated;

-- ---------- funções chamadas pelo Studio ----------

create function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Faça login.' using errcode = 'PT401';
  end if;
  insert into public.organizations (name) values (trim(p_name)) returning id into v_org;
  insert into public.memberships (org_id, user_id, role, display_name)
  values (v_org, auth.uid(), 'admin', coalesce((select email from auth.users where id = auth.uid()), ''));
  insert into public.workspaces (org_id) values (v_org);
  return v_org;
end
$$;

-- A pessoa precisa ter criado a conta antes; chamar de novo muda o papel.
create function public.add_member(p_org uuid, p_email text, p_role text, p_display_name text default '')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if public.member_role(p_org) is distinct from 'admin' then
    raise exception 'Só o administrador da empresa gerencia a equipe.' using errcode = 'PT403';
  end if;
  if p_role not in ('admin', 'office', 'promoter') then
    raise exception 'Papel inválido: %', p_role using errcode = 'PT400';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'Nenhuma conta com o e-mail %. Peça para a pessoa criar a conta primeiro.', trim(p_email)
      using errcode = 'PT404';
  end if;
  if v_user = auth.uid() and p_role <> 'admin' then
    raise exception 'Você não pode tirar o seu próprio papel de administrador.' using errcode = 'PT409';
  end if;
  insert into public.memberships (org_id, user_id, role, display_name)
  values (p_org, v_user, p_role, coalesce(nullif(trim(p_display_name), ''), lower(trim(p_email))))
  on conflict (org_id, user_id) do update
    set role = excluded.role,
        display_name = coalesce(nullif(trim(p_display_name), ''), public.memberships.display_name);
  return v_user;
end
$$;

create function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.member_role(p_org) is distinct from 'admin' then
    raise exception 'Só o administrador da empresa gerencia a equipe.' using errcode = 'PT403';
  end if;
  if p_user = auth.uid() then
    raise exception 'Você não pode se remover da empresa.' using errcode = 'PT409';
  end if;
  delete from public.memberships where org_id = p_org and user_id = p_user;
end
$$;

-- Grava o projeto inteiro de uma vez (tudo ou nada). Falha com PT409 se a nuvem
-- não estiver mais na revisão que o Studio leu.
create function public.save_workspace(
  p_org uuid,
  p_expected_revision bigint,
  p_data jsonb,
  p_stores jsonb,
  p_products jsonb,
  p_publication jsonb default null
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare
  v_revision bigint;
  v_version int;
begin
  if not public.is_office(p_org) then
    raise exception 'Sem permissão para gravar o projeto desta empresa.' using errcode = 'PT403';
  end if;
  insert into public.workspaces (org_id) values (p_org) on conflict do nothing;
  select revision into v_revision from public.workspaces where org_id = p_org for update;
  if v_revision is distinct from p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409', detail = v_revision::text;
  end if;

  update public.workspaces
  set revision = revision + 1, data = p_data, updated_at = now(), updated_by = auth.uid()
  where org_id = p_org
  returning revision into v_revision;

  delete from public.stores
  where org_id = p_org and id not in (select s ->> 'id' from jsonb_array_elements(p_stores) s);
  insert into public.stores (org_id, id, position, data)
  select p_org, s.value ->> 'id', s.pos, s.value
  from jsonb_array_elements(p_stores) with ordinality as s(value, pos)
  on conflict (org_id, id) do update
    set position = excluded.position, data = excluded.data, updated_at = now()
    where public.stores.data is distinct from excluded.data or public.stores.position <> excluded.position;

  delete from public.products
  where org_id = p_org and sku not in (select p ->> 'sku' from jsonb_array_elements(p_products) p);
  insert into public.products (org_id, sku, ean, position, data)
  select p_org, p.value ->> 'sku', coalesce(p.value ->> 'ean', ''), p.pos, p.value
  from jsonb_array_elements(p_products) with ordinality as p(value, pos)
  on conflict (org_id, sku) do update
    set ean = excluded.ean, position = excluded.position, data = excluded.data, updated_at = now()
    where public.products.data is distinct from excluded.data or public.products.position <> excluded.position;

  v_version := (p_publication ->> 'version')::int;
  if v_version is not null
    and not exists (select 1 from public.publications where org_id = p_org and version = v_version) then
    insert into public.publications (org_id, version, published_at, published_by, note, time_tracking)
    values (
      p_org, v_version, (p_publication ->> 'publishedAt')::timestamptz, auth.uid(),
      coalesce(p_publication ->> 'note', ''), coalesce((p_publication ->> 'timeTracking')::boolean, true)
    );
    insert into public.planograms (org_id, version, id, store_id, data)
    select p_org, v_version, g ->> 'id', g ->> 'storeId', g
    from jsonb_array_elements(coalesce(p_publication -> 'planograms', '[]')) g;
  end if;
  return v_revision;
end
$$;

-- Lê o projeto inteiro numa resposta só (sem o limite de linhas por página da API).
create function public.load_workspace(p_org uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  if not public.is_office(p_org) then
    raise exception 'Sem permissão para abrir o projeto desta empresa.' using errcode = 'PT403';
  end if;
  select jsonb_build_object(
    'revision', coalesce(w.revision, 0),
    'updatedAt', w.updated_at,
    'data', coalesce(w.data, '{}'),
    'stores', coalesce((select jsonb_agg(s.data order by s.position) from public.stores s where s.org_id = p_org), '[]'),
    'products', coalesce((select jsonb_agg(p.data order by p.position) from public.products p where p.org_id = p_org), '[]'),
    'publication', (
      select jsonb_build_object(
        'version', pub.version,
        'publishedAt', pub.published_at,
        'note', pub.note,
        'timeTracking', pub.time_tracking,
        'planograms', coalesce(
          (select jsonb_agg(g.data order by g.id) from public.planograms g
           where g.org_id = p_org and g.version = pub.version), '[]')
      )
      from public.publications pub where pub.org_id = p_org order by pub.version desc limit 1
    )
  ) into v_result
  from (select 1) one
  left join public.workspaces w on w.org_id = p_org;
  return v_result;
end
$$;

revoke execute on function public.member_role(uuid), public.is_member(uuid), public.is_office(uuid),
  public.assigned_to_store(uuid, text), public.org_of_object(text), public.create_organization(text),
  public.add_member(uuid, text, text, text), public.remove_member(uuid, uuid),
  public.save_workspace(uuid, bigint, jsonb, jsonb, jsonb, jsonb), public.load_workspace(uuid)
  from public, anon;
grant execute on function public.member_role(uuid), public.is_member(uuid), public.is_office(uuid),
  public.assigned_to_store(uuid, text), public.org_of_object(text), public.create_organization(text),
  public.add_member(uuid, text, text, text), public.remove_member(uuid, uuid),
  public.save_workspace(uuid, bigint, jsonb, jsonb, jsonb, jsonb), public.load_workspace(uuid)
  to authenticated;

-- ---------- imagens dos produtos (Storage) ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 5242880, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

create policy "membros leem imagens de produto" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and public.is_member(public.org_of_object(name)));
create policy "escritório envia imagens de produto" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_office(public.org_of_object(name)));
create policy "escritório troca imagens de produto" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.is_office(public.org_of_object(name)))
  with check (bucket_id = 'product-images' and public.is_office(public.org_of_object(name)));
create policy "escritório apaga imagens de produto" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.is_office(public.org_of_object(name)));

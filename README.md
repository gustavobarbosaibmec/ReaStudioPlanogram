# Planograma

Dois apps que conversam por arquivo, sem servidor e sem internet:

- **Planograma Studio** (`index.html`, computador): monta o planograma automaticamente,
  permite editar à mão, gera um planograma por loja, publica versões e revisa a execução.
- **Planograma Campo** (`campo.html`, APK Android): o promotor recebe os planogramas da loja,
  vê tudo offline, confere posição por posição, tira fotos e devolve o relatório.

As referências públicas usadas (Spaceman, PlanoHero, Figueira Costa) e o grau de certeza de
cada uma estão na aba **Evidências** do Studio. Nenhum código, marca ou formato deles é usado.

## Rodar no computador

```bash
npm start
```

Studio em http://localhost:5180 e app do promotor em http://localhost:5180/campo.html.
Testes: `npm test` (Node 22.15+). O `npm start` usa os certificados do Windows/sistema
(`--use-system-ca`), necessário quando um antivírus inspeciona HTTPS.

## Fluxo com o promotor

1. **Studio › Execução › Publicar nova versão**: gera o planograma de cada loja (a loja aberta
   no editor vai com as edições manuais), com recado e cronômetro opcionais.
2. **Baixar pacote para o app**: um `.json` com planogramas, produtos (com foto e EAN) e as
   decisões de revisão. Envie por WhatsApp, e-mail ou Drive.
3. No celular, **Receber pacote**: as tarefas aparecem como *Novo*. Daqui em diante não precisa
   de internet.
4. O promotor toca **Iniciar execução**, tira a **foto do antes**, confere cada produto
   (✓ certo ou ! problema: ruptura, posição errada, frentes, preço/etiqueta), tira a
   **foto do depois** e toca **Concluir**.
5. **Enviar relatório** gera um `.json` e abre o compartilhamento do Android.
6. **Studio › Execução › Importar relatório**: conformidade, problemas, fotos e tempo por loja.
   **Aprovar** ou **Devolver** com comentário; a decisão chega ao promotor no próximo pacote,
   e uma tarefa devolvida volta para execução mantendo o que já foi conferido.

Uma versão nova do mesmo planograma substitui a tarefa no aparelho; a mesma versão é ignorada.

## Virada da loja e vendas antes × depois

A **virada** de uma loja só é contabilizada quando a execução concluída (ou aprovada) tem foto
do **antes** e do **depois**. A data da virada é a da última foto do depois. Execução devolvida
pelo escritório não conta até ser refeita. A aba Execução mostra a virada de cada loja.

Em **Lojas › Vendas e virada**, carregue a venda da loja:

- **Planilha CSV** com data, EAN ou SKU, quantidade e valor; com coluna de loja, o arquivo pode
  trazer várias lojas (reconhecidas pelo id, nome ou *Código na base*). Reimportar o mesmo dia e
  produto substitui, não duplica.
- **API** de uma base existente (conexão *Base de vendas* em Integrações), por loja e período.

A comparação usa N dias antes × N dias depois (14, 28 ou 56; o dia da virada fica de fora), em
média por dia com venda, por padrão só com os produtos do cadastro (a categoria). Mostra
unidades e receita, variação, gráfico diário, subcategorias e maiores ganhos e quedas por
produto, e avisa quando faltam dias de dados ou a janela depois ainda não fechou. É uma
comparação antes × depois da própria loja: sazonalidade, preço e promoções não são isolados.

## Integrações (chaves de API)

Aba **Integrações**: *Base de vendas (API REST/JSON)* com caminho, cabeçalho de autenticação e
nomes dos campos configuráveis; *Cosmos (Bluesoft)* para completar descrição, marca e medidas
pelo EAN (Produtos › Completar pelo EAN, só preenche o que falta, com conferência); e *Outra
plataforma* para guardar uma chave e testá-la. As chaves ficam só no navegador deste
computador, sem criptografia, e não vão no “Salvar projeto” nem nos pacotes para o app. As
chamadas passam pelo servidor local (`npm start`), que só aceita pedidos da própria página e só
endereços https.

## Nuvem (Supabase), fase 1

O Studio pode guardar o projeto num banco Supabase. Assim várias pessoas do escritório trabalham
no mesmo projeto e nada se perde se o navegador for limpo. Sem nuvem configurada, tudo continua
funcionando só no computador, como antes.

1. Crie o projeto em supabase.com (região São Paulo).
2. No **SQL Editor**, rode o conteúdo de `supabase/migrations/20261031120000_fase1_base.sql`.
   Ele cria as tabelas, as regras de acesso e o bucket de imagens.
3. No Studio, em **Integrações › Nuvem**, cole o endereço do projeto e a **chave pública**
   (anon ou publishable, em Project Settings › API Keys). O Studio recusa a chave secreta
   (service_role): ela ignora as regras de acesso e nunca pode ficar no navegador.
4. Crie sua conta, crie a empresa e adicione a equipe pelo e-mail. Cada pessoa cria a própria
   conta antes de ser adicionada.

O que sobe: gôndola, regras, planograma em edição, revisões, lojas, produtos, a última versão
publicada e as imagens dos produtos (bucket `product-images`, uma pasta por empresa). A aba
aberta, o zoom e a seleção ficam só no computador. As chaves de API das integrações também
continuam só no navegador.

Como sincroniza:

- O envio é automático alguns segundos depois de cada alteração. Ao voltar para a aba, o Studio
  confere se outra pessoa gravou e baixa a versão nova.
- Cada gravação diz qual revisão leu. Se outra pessoa gravou antes, nada é sobrescrito: o Studio
  mostra **Conflito** e pergunta qual versão fica. Ao ficar com a da nuvem, a versão deste
  computador fica guardada como cópia de segurança no navegador (`office.backup`).
- Sem internet, o Studio continua funcionando e mostra **Offline**. As alterações sobem quando a
  conexão voltar.

Papéis: **Administrador** (gerencia a equipe), **Escritório** (planeja e publica) e **Promotor**
(só lê os produtos e os planogramas das lojas atribuídas a ele). As regras ficam no banco
(RLS), não só na tela. O teste `test/supabase.test.mjs` roda a migração num Postgres local
(PGlite) e confere essas regras.

Próximas fases: app do promotor com login e sincronização (tarefas, relatórios e fotos),
vendas no banco com a análise da virada em SQL, e chaves de API em Edge Functions.

## Imagens e medidas dos produtos

A plataforma não vem com imagens: elas vêm do cadastro de vocês (fornecedores, GS1, fotos
próprias). O **EAN** liga tudo. Na aba **Produtos**:

1. **Planilha** (CSV; no Excel, *Salvar como › CSV*). As colunas são reconhecidas pelo nome:
   EAN/GTIN/Código de barras, SKU/Código, Descrição, Marca, Subcategoria, Largura, Altura,
   Profundidade, Venda semanal, Preço, Margem. Medidas em cm; se o cabeçalho disser “mm”
   (ex.: `Largura (mm)`), converte sozinho. Produtos existentes são atualizados pelo EAN ou SKU
   e campos vazios não apagam nada; produtos novos sem medida entram desativados.
2. **Pasta de imagens**: uma foto de frente por produto, com o EAN no nome
   (`7891000100103.png`, `7891000100103_frente.jpg`) ou o SKU. Arraste a pasta ou escolha os
   arquivos. Fotos com `lado`, `topo` ou `verso` no nome são ignoradas.
3. **Conferência** antes de salvar: imagens associadas (com bordas brancas já cortadas e
   reduzidas para até 480 px em WebP), arquivos não reconhecidos com o motivo (EAN fora do
   cadastro, dígito verificador inválido, nome sem código) e produtos que continuam sem foto.
   Fotos cuja proporção não bate com largura × altura são marcadas; quando a foto está
   deitada e as medidas em pé, dá para trocar largura ↔ altura ali mesmo.

As fotos ficam numa biblioteca separada no navegador do escritório e vão para os celulares
num **pacote de imagens** (aba Execução › Baixar imagens para o app), enviado à parte do pacote
de planogramas: só precisa ser reenviado quando as fotos mudarem. O app avisa quando há produto
sem foto no aparelho.

## APK (GitHub Actions)

O workflow `.github/workflows/android-apk.yml` roda os testes e gera `planograma-campo.apk`
a cada push na `main`. Baixe em **Actions › (execução) › Artifacts**. Ao criar uma tag `v*`
(ex.: `v1.0.0`), o APK também vai para a página **Releases**.

Para instalar no celular: abra o APK e permita "instalar apps desconhecidos" para o app que
abriu o arquivo (navegador, Drive ou WhatsApp).

Assinatura: o APK usa uma chave fixa de distribuição interna (`android/app/planograma-debug.p12`),
para que cada atualização instale por cima da anterior sem apagar os dados do promotor. Para
publicar na Play Store, gere uma chave própria e guarde-a nos *secrets* do GitHub.

Para gerar localmente é preciso JDK 21 e Android SDK: `npm run android:apk`.

## Como o planograma é gerado

1. **Árvore de decisão → blocos**: até 3 níveis (ex.: Subcategoria › Marca), cada um com direção
   (vertical/horizontal) e sequência.
2. **Espaço por bloco** proporcional a unidades, receita ou margem, com mínimo para caber o
   sortimento; opcionalmente encaixado nos módulos.
3. **Frentes** pelo DOS alvo: `ceil(venda diária × DOS ÷ (altura × profundidade))`, entre mín. e máx.
4. **Fluxo** de cima para baixo, esquerda para a direita; sobra vai para o menor DOS.
5. **Conformidade**: sobreposição, fora da gôndola, altura maior que o vão, DOS abaixo do mínimo.

## Arquivos

- `src/engine.js`: geração (blocos, espaço, frentes, lojas)
- `src/metrics.js`: indicadores e validação
- `src/sales.js`: venda da loja e comparação antes × depois da virada
- `src/integrations.js`: conexões de API (modelos, requisição, leitura da resposta); `src/charts.js`: gráfico diário
- `src/catalog.js`: EAN/GTIN, planilha de cadastro e associação de imagens pelo nome do arquivo
- `src/pack.js`: pacotes de planogramas e de imagens, tarefas, relatório, revisão (formato de troca)
- `src/render.js`: desenho da gôndola em SVG
- `src/app.js`: Studio; `src/field.js`: app do promotor
- `src/cloud.js`: nuvem Supabase (login, projeto, imagens e decisão de sincronização); `supabase/migrations/`: banco e regras de acesso
- `src/store.js`: dados no aparelho (IndexedDB); `src/files.js`: salvar/compartilhar arquivos e fotos
- `android/`: projeto Capacitor; `scripts/build-www.mjs` copia o app do promotor para o APK

## Limitações

- O app do promotor ainda troca planogramas e relatórios por arquivo. A sincronização dele com a
  nuvem é a fase 2.
- Se o Studio publicar duas versões seguidas sem internet, só a última chega à nuvem. Imagens
  que deixam de ser usadas não são apagadas do Storage.
- Sem realidade aumentada, leitura de código de barras pela câmera nem notificação push.
  A busca por EAN é digitada.
- Prateleiras com vão igual; sem ganchos, caixas ou acessórios.
- Fotos ficam no relatório em JPEG reduzido (até 1280 px); muitas fotos deixam o arquivo grande.

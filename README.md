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
Testes: `npm test` (Node 20+).

## Fluxo com o promotor

1. **Studio › Execução › Publicar nova versão**: gera o planograma de cada loja (a loja aberta
   no editor vai com as edições manuais), com recado e cronômetro opcionais.
2. **Baixar pacote para o app**: um `.json` com planogramas, produtos (com foto e EAN) e as
   decisões de revisão. Envie por WhatsApp, e-mail ou Drive.
3. No celular, **Receber pacote**: as tarefas aparecem como *Novo*. Daqui em diante não precisa
   de internet.
4. O promotor toca **Iniciar execução**, confere cada produto (✓ certo ou ! problema: ruptura,
   posição errada, frentes, preço/etiqueta), tira fotos e toca **Concluir**.
5. **Enviar relatório** gera um `.json` e abre o compartilhamento do Android.
6. **Studio › Execução › Importar relatório**: conformidade, problemas, fotos e tempo por loja.
   **Aprovar** ou **Devolver** com comentário; a decisão chega ao promotor no próximo pacote,
   e uma tarefa devolvida volta para execução mantendo o que já foi conferido.

Uma versão nova do mesmo planograma substitui a tarefa no aparelho; a mesma versão é ignorada.

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
- `src/catalog.js`: EAN/GTIN, planilha de cadastro e associação de imagens pelo nome do arquivo
- `src/pack.js`: pacotes de planogramas e de imagens, tarefas, relatório, revisão (formato de troca)
- `src/render.js`: desenho da gôndola em SVG
- `src/app.js`: Studio; `src/field.js`: app do promotor
- `src/store.js`: dados no aparelho (IndexedDB); `src/files.js`: salvar/compartilhar arquivos e fotos
- `android/`: projeto Capacitor; `scripts/build-www.mjs` copia o app do promotor para o APK

## Limitações

- Sem sincronização automática: a troca é por arquivo. Um servidor pode ser adicionado depois
  mantendo os mesmos formatos de pacote e relatório.
- Sem realidade aumentada, leitura de código de barras pela câmera nem notificação push.
  A busca por EAN é digitada.
- Prateleiras com vão igual; sem ganchos, caixas ou acessórios.
- Fotos ficam no relatório em JPEG reduzido (até 1280 px); muitas fotos deixam o arquivo grande.

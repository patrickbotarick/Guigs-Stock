# Guig's Stock — ajustes de homologação 1.5

Branch: `feature/1.5-homologation-adjustments`.
Base: `d2d0bca5934f3e3e153396dcab9dda7f5ea7cad8`, igual à `origin/main` após fetch em 07/10/2026.
A main permaneceu intacta. Não houve push, merge, tag, deploy nem alteração do Supabase piloto.

## Alterações e commits

| Commit | Bloco |
| --- | --- |
| `8640c33` | Migration de fornecedores, recebimento compatível e consulta FEFO |
| `1216de8` | Seleção, cadastro/edição/inativação e exibição do fornecedor |
| `669dc55` | Confirmação FEFO na transferência estoque → geladeira |
| `bcf6a62` | Sidebar fixa, navegação por hash e histórico separado |
| Commit final de testes | Suítes isoladas, proteção contra envio duplicado/cancelamento e este guia |

Arquivos da aplicação alterados: `index.html`, `cloud-dashboard.js`, `service-worker.js`.
Arquivos novos: `supabase/migrations/006_homologation_suppliers_fefo.sql`, `tests/database.cjs`, `tests/browser.cjs` e este guia.
Migrations 001–005, autenticação, manifest, config.example.js e .gitignore foram preservados.
`config.js` continua ignorado e não foi lido pelos testes. A configuração gerada no deploy usa a mesma interface anterior.

## Banco e fornecedores

- `guigs_suppliers`: UUID, loja, nome (1–160 caracteres), ativo/inativo e criação; nome único por loja, ignorando caixa e espaços nas pontas.
- `guigs_lots.supplier_id`: nullable; lotes existentes permanecem sem fornecedor. A FK composta `(shop_id, supplier_id)` impede fornecedores de outra loja.
- Índices para nome por loja, referência de fornecedor e consulta FEFO.
- RLS usa `guigs_private.is_member`. Membros ativos leem fornecedores somente da própria loja.
- Escrita direta permanece revogada. `guigs_create_supplier` e `guigs_update_supplier` exigem owner ativo da loja no servidor. Não há exclusão de fornecedores.
- O atendente conserva a permissão de recebimento e pode selecionar um fornecedor ativo, sem receber permissão de gestão.
- A nova assinatura de `guigs_receive_stock` recebe `p_supplier_id`. Verifica loja, fornecedor ativo, produto, quantidade e validade; mantém a serialização dos recebimentos do mesmo lote.
- A assinatura antiga de seis parâmetros, com observação opcional, continua disponível; NULL não apaga fornecedor existente. Clientes antigos ainda podem criar lotes sem fornecedor.
- Receber novamente o mesmo produto/código/validade com fornecedor diferente é rejeitado: use um código distinto. Não se sobrescreve a origem do lote.
- Um recebimento atual com fornecedor pode vincular um lote antigo ainda sem fornecedor. O histórico anterior permanece intacto.
- O nome do fornecedor é registrado na observação do novo recebimento. Esse snapshot não muda após renomeação. A interface limita a observação digitada a 800 caracteres para caber com o nome no limite já existente de 1000; não trunca informação.
- Recebimentos novos na interface exigem fornecedor ativo. O owner pode cadastrar pelo botão “+ Novo fornecedor” ou gerenciar em “Fornecedores”. Inativar mantém os vínculos e a visualização dos lotes existentes.
- Fornecedores são exibidos nos lotes com saldo; os antigos mostram “Fornecedor: Não informado”. As observações do histórico agora ficam visíveis, incluindo o snapshot do recebimento.

## FEFO

`guigs_get_fefo_candidates` consulta no servidor os lotes do mesmo produto/loja com saldo **seco atual > 0**, excluindo o escolhido. Prioriza validade anterior e, em empate, criação anterior. Lista todos os prioritários por validade/criação, com ID como ordenação final determinística. Não consulta todo o histórico no navegador.

O aviso só é usado em estoque → geladeira. Cancelar ou Esc não chama a RPC de transferência. Continuar movimenta o lote escolhido; a RPC existente ainda valida saldo e bloqueia operações concorrentes que produziriam saldo negativo. Retorno geladeira → estoque permanece sem FEFO.

A consulta do aviso é uma fotografia do saldo naquele instante. Outros usuários podem movimentar estoque enquanto a confirmação está aberta; a transferência revalida o saldo do lote escolhido no servidor. FEFO é orientação, sem reserva de lotes prioritários. Lotes prioritários vencidos também podem aparecer porque possuem validade anterior; continuam sujeitos às regras existentes que impedem enviá-los à geladeira.

Falha ao consultar FEFO é exibida na janela e encerra essa tentativa, permitindo tentar novamente; não há transferência silenciosa sem conferência. Falta de internet impede operações, como já ocorria. Cancelar a janela durante uma consulta pendente também impede a transferência. Envios simultâneos da mesma janela são ignorados enquanto a operação está em andamento.

## Navegação e PWA

- `#visao-geral`: operações, métricas, alertas, produtos e validades existentes.
- `#historico`: histórico com toda a largura disponível, filtros, busca, responsável e paginação server-side de 20 itens. Os filtros permanecem ao alternar views.
- Não há recarga ao alternar, framework ou router novo. Links diretos e navegação de voltar/avançar usam o hash.
- Sidebar de 225 px fixa no desktop (>950 px), com scroll vertical próprio; o conteúdo respeita sua largura.
- Em telas ≤950 px a navegação fica no topo e pode quebrar linha. As tabelas continuam com scroll horizontal próprio no celular.
- Cache do service worker atualizado de v5 para `guigs-stock-shell-v6`; manifest e integração Cloudflare/config mantidos.
- Offline preserva o shell e a mensagem de conexão; dados em nuvem e operações continuam dependentes de internet. Não foi criado estoque local sincronizável.

## Aplicar a migration manualmente

1. Use primeiro um projeto Supabase de homologação com migrations **001–005 já aplicadas**.
2. No SQL Editor desse projeto, execute todo o arquivo `supabase/migrations/006_homologation_suppliers_fefo.sql` **uma única vez**. Ele usa transação e notifica o PostgREST para recarregar o schema.
3. Confirme que a tabela `guigs_suppliers`, a coluna `guigs_lots.supplier_id`, a FK composta, a policy de leitura e as novas RPCs existem.
4. Valide pelo cliente autenticado: owner cadastra/edita; attendant apenas lê/recebe; conta de outra loja não lê nem vincula esses fornecedores. Confirme as duas assinaturas de recebimento via PostgREST.
5. Cadastre pelo menos um fornecedor ativo antes de testar recebimentos na nova interface. Não há carga automática de fornecedores.

Esta migration não é um script para reexecução: não a reaplique após sucesso. Nenhuma migration foi aplicada ao Supabase real nesta tarefa. Não execute reset nem remova dados. A aplicação nova requer a migration antes de ser disponibilizada, pois lê a nova tabela/coluna. O frontend antigo pode continuar funcionando após a migration.

## Testar localmente

1. Continue na branch de desenvolvimento. Copie `config.example.js` para `config.js` **somente se o arquivo local ainda não existir**.
2. Configure URL e chave publicável do Supabase de homologação. Preserve qualquer configuração local existente; nunca use service_role.
3. Após aplicar a migration no ambiente de teste, execute `Abrir Guigs Stock.bat` e acesse `http://127.0.0.1:8082/`.
4. Entre com contas de teste já autorizadas como owner e attendant. Não altere usuários reais.
5. Valide `http://127.0.0.1:8082/#historico` e retorno para Visão geral; teste desktop e celular.

## Testes automatizados executados

As dependências foram instaladas/carregadas fora da aplicação; não há novo runtime ou framework no frontend.

| Validação | Resultado |
| --- | --- |
| Migrations 001–006 em PostgreSQL isolado/PGlite, com pgcrypto e auth.uid simulado | 39 verificações aprovadas |
| Edge headless, HTML/JS reais e cliente Supabase simulado | 45 verificações aprovadas |
| Sintaxe JavaScript da aplicação e testes | Aprovada |
| `git diff --check` | Aprovado |
| Revisão visual das capturas desktop/mobile de histórico e FEFO | Sem sobreposição da sidebar ou ações cortadas |

Banco: owner/attendant, RLS, outra loja, vínculo inativo, anonimato, escrita direta negada, nomes duplicados, fornecedor inativo, recebimento, conflito de fornecedor, snapshot após renomeação, compatibilidade RPC antiga, lote antigo, FEFO/empate/saldo zero, transferência não bloqueada pela prioridade, conservação de saldos, histórico/filtros/busca/paginação.

Navegador: login simulado owner/attendant, dashboard, lotes novos/antigos, cadastro/inativação/seleção/recebimento, sidebar fixa com scroll e mobile, troca de views/hash, filtros e paginação, aviso FEFO, cancelar/Esc/continuar, saldo após movimentação, lote prioritário zerado, retorno sem FEFO, erro da consulta, cancelamento durante consulta, desconexão durante confirmação, botões FEFO no celular, cache v6, offline/online e login pelo shell offline. Console sem erros críticos.

Para repetir em uma máquina com Node.js e Edge:

```powershell
# Instalação de dependências apenas numa pasta temporária.
$testDeps = Join-Path $env:TEMP 'guigs-stock-test-deps'
npm install --prefix $testDeps --no-audit --no-fund @electric-sql/pglite playwright
$env:PGLITE_MODULE_PATH = Join-Path $testDeps 'node_modules\@electric-sql\pglite'
$env:PLAYWRIGHT_MODULE_PATH = Join-Path $testDeps 'node_modules\playwright'
node tests/database.cjs
node tests/browser.cjs
```

`BROWSER_EXECUTABLE` pode apontar para outro Chromium instalado. `TEST_ARTIFACTS_DIR` é opcional para salvar capturas. Os testes não acessam o Supabase, não leem o config.js real e não tocam no perfil pessoal do navegador.

## Homologação manual pendente

Os testes isolados não substituem validação do Supabase Auth/PostgREST/RLS real, Cloudflare Pages e instalação da PWA em dispositivos reais. Use ambiente e dados de homologação:

1. Login real owner e attendant; sessão persistente e saída.
2. Dashboard e alertas; sidebar fixa no desktop com scroll; navegação acessível no celular; Visão geral ↔ Histórico.
3. Filtros por produto, tipo, datas, responsável e busca; paginação com mais de 20 movimentos; responsável identificado.
4. Owner cadastra, renomeia e inativa fornecedor; attendant visualiza e seleciona sem poder administrar. Validar isolamento entre duas lojas e escrita direta negada.
5. Receber lote com fornecedor; consultar origem; consultar lote legado sem fornecedor; rejeitar fornecedor inativo/de outra loja e conflito de origem.
6. Coca-Cola 2L: LOTE-A vence **10/11/2026**, seco 10; LOTE-B vence **10/12/2026**, seco 10. Escolher B e mover 5: A deve ser avisado; cancelar mantém saldos; repetir/continuar deixa B com seco 5 e geladeira 5. Quando A tiver seco zero, B não deve gerar aviso. Em empate, testar criação anterior. Testar o lote correto sem aviso e geladeira → estoque sem FEFO.
7. Em duas sessões, movimentar o mesmo lote simultaneamente; verificar que saldo insuficiente é rejeitado e histórico mantém as duas linhas de cada transferência.
8. Offline/online com a PWA já aberta e shell previamente carregado; instalação no celular; atualização do service worker de um cliente antigo; console sem erros críticos.
9. Validar config.js local e configuração gerada no deploy em preview de homologação, quando autorizado. Nenhuma publicação foi feita nesta tarefa.

Após essa validação, revisar a branch antes de autorizar qualquer merge ou publicação.

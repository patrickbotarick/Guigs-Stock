# Validação final consolidada do mapa de geladeiras

Documento consolidado de 05/11/2026, America/Sao_Paulo. A auditoria inicial no código a0448a0 resultou em NO-GO. A seção abaixo registra a correção dos dois bloqueios; as tabelas posteriores preservam a evidência histórica e são substituídas pelo novo aceite quando concluído.

## Correção dos bloqueios e novo aceite

Branch codex/image-library-admin, baseada em 45caa6d (auditoria) e main a0448a0. Código novo publicado: `587931acb3978e1596a607afb83ab5f9e5a445ef`; 18/18 arquivos Pages conferidos, shell v15. A causa da administração ausente era implementação de UI inexistente, não CSS/permissão/build. Agora Gerenciar imagens reúne rename, estado, filtros, confirmação de exclusão e recuperação de falhas. Ver [contrato completo](BIBLIOTECA_IMAGENS.md).

A migration 20261105182536_image_library_administration.sql passou no PGlite e no Supabase de homologação antes de produção. O conector apply_migration expirou três confirmações sem executar em produção; a execução autorizada usou psql local, alvo fixo e PGPASSFILE privado existente, TLS verify-full, conferência de identidade/ausência da fila, hash exato 675D7DABE13DBD3F61242DC3C7A3EF19201EFAC1481EE60004E0EC6A131E27F7 e ON_ERROR_STOP. Não houve db push, reexecução de migrations históricas ou reparo automático de supabase_migrations. Esta aplicação deve ser identificada pelo arquivo/hash e por este registro, sem tentar reaplicá-la para preencher histórico. Cinco RPCs e fila vazia confirmadas por SELECT após a execução; anon sem EXECUTE e clientes sem SELECT/DML direto na fila.

Backup manual do administrador pre-image-admin-2026-11-05_18-33-48-4b0c7d91: archive 404.691 bytes, SHA-256 69A948CE9B5003A9BD37246D9BB7F3F7E6C089FB1202D4D69C60A0F6486CE1AE, manifesto e baseline do mesmo snapshot conferidos. Não foi feito restore nem exportação automática pelo agente.

O vínculo de POTY já estava corrigido na primeira leitura desta nova rodada: objeto/catálogo válidos e SHA-256 igual ao original local Poty 2L.png. Não foi regravado por conveniência. O fingerprint de produtos atual é 99e6fcefc4cf10a8531165823df0b1f1; a mudança diante da auditoria anterior corresponde ao vínculo corrigido antes desta rodada. Todos os demais fingerprints da tabela histórica, inclusive lotes/layout/Auth/memberships/catálogo/objetos/ledger, são iguais, e o fingerprint de produtos atual também ficou estável durante esta correção.

Owner autenticado de produção: reload com 13 blocos e estoque sincronizado, foto POTY no bloco e modal (500×500), biblioteca/thumbnail, entrada Gerenciar imagens, filtros e campo Renomear acessíveis. Exclusão de POTY mostra 1 produto e bloqueia o botão destrutivo; oferece Desativar. A confirmação de desativação informa preservação dos vínculos. Uma imagem sem uso mostra o alerta de irreversibilidade e Excluir permanentemente. Todas as confirmações foram canceladas: nenhuma imagem real foi apagada ou desativada. A inspeção interativa registrou os estados da interface e carregamento real; captura CDP de imagem do modal ficou indisponível por timeout, sem afetar o fluxo verificado. Não se afirma existir screenshot dessa sessão.

Regressão atual: 1.206 gerais/14 suítes e 553 espaciais/12 suítes PASS, incluindo 50 controles administrativos backend e 168 de navegador. Homologação real: 52 controles administrativos PASS (UI/API owner/delegado, negativas para atendente e cross-shop, arquivo em uso e falhas antes/depois da remoção); 49 controles de mapa/PWA/logout-login em três papéis PASS. Shell v15, limpeza dos caches v11/v12/v14, offline/reload e imagens fora do cache testados. Instalação manual: **PENDING NÃO BLOQUEANTE**.

Auditoria atual de órfãos: zero catálogo sem objeto, zero objeto sem catálogo, zero vínculo sem catálogo/objeto; zero exclusões pendentes de produção. Baseline segue 184 = 178 + 6, ledger 687 e MD5 0470bca16323e2652e046bfe200d297c, dois movimentos espaciais e Activation Point anterior preservado. Sem escrita de estoque, lotes, histórico, inventário, FEFO, capacidades, layout ou Auth/memberships. A migration e o deploy foram as intervenções de produção autorizadas.

Estado do aceite: controles owner aprovados e aguardando smoke de leitura do atendente de produção, incluindo foto/reload/PWA/logout-login. A matriz final será encerrada após essa etapa.

### Matriz específica da correção

| Item | Resultado | Evidência |
|---|---|---|
| Causa biblioteca ausente | PASS | UI não implementada em a0448a0; backend apenas parcial. |
| Interface administrativa | PASS | Gerenciar imagens e filtros acessíveis ao owner publicado; delegado em homologação. |
| Rename | PASS | UI/reload reais de homologação; somente display_name mudou; campo publicado acessível. |
| Deactivate | PASS | Confirmação; vínculo e leitura preservados em homologação; modal publicado aberto/cancelado. |
| Reactivate | PASS | Volta ao seletor em homologação, objeto existente exigido; código publicado idêntico ao validado. |
| Delete | PASS | Dois arquivos artificiais removidos pela API em homologação, registro/fila encerrados; nenhuma exclusão real de produção. |
| Confirmação | PASS | Thumbnail, nome, alerta, Cancelar e ação destrutiva no build publicado; cancelamento sem escrita. |
| Proteção imagem em uso | PASS | RPC nega; POTY publicado mostra 1 vínculo e não oferece confirmar exclusão. |
| Owner | PASS | UI/API homologação e inspeção interativa publicada. |
| manage_fridge_layout | PASS | UI/API real de homologação, inclusive delete e falhas intermediárias. |
| Attendant | PENDING | API negada e UI restrita em homologação; novo smoke de leitura de produção aguardando login. |
| Cross-shop | PASS | Cinco RPCs negadas em homologação, tabela privada sem acesso direto. |
| POTY storage object | PASS | Existe, catálogo válido, hash do original local coincidente; nenhum reenvio necessário. |
| POTY bloco | PASS | Owner publicado, foto carregada após reload; leitura do atendente ainda pendente. |
| POTY modal | PASS | Owner publicado, imagem 500×500; leitura do atendente ainda pendente. |
| Orphan audit | PASS | Zero nas categorias catálogo/objeto/vínculo; fila de produção vazia; sem limpeza. |
| PWA | PASS | Shell v15, 49 controles reais de homologação; ciclo publicado do atendente pendente. Instalação manual: PENDING NÃO BLOQUEANTE. |
| Testes | PASS | 1.206 gerais + 553 espaciais + 52 admin homolog + 49 mapa/PWA homolog; 13 de alvo. |
| Produção | PENDING | Migration aplicada, 18/18 arquivos, owner PASS; aguardando leitura do atendente. |
| Saldo fridge | PASS | 184 preservado. |
| Unallocated | PASS | 178 preservado. |
| Slot | PASS | 6 preservado. |
| Ledger | PASS | 687 preservados. |
| Fingerprint | PASS | Ledger 0470bca16323e2652e046bfe200d297c; demais escopos estáveis no baseline desta rodada. |
| 30 gates finais | PENDING | Reavaliação abaixo; falta somente smoke real de leitura do atendente para fechar. |

### Reavaliação dos 30 gates

| Gate | Resultado | Evidência atual / reaproveitada |
|---|---|---|
| 1 — Git | PASS | Branch isolada, histórico auditado, main publicado 587931a; nenhum arquivo privado adicionado. |
| 2 — Produção | PASS | SQL/grants e saúde acessíveis, HTTP/build 18/18; sem alteração de configurações externas. |
| 3 — Modelo físico | PASS | 2/7/13; reload owner publicado e logout/login nos três papéis de homologação. |
| 4 — Editor | PASS | 553 espaciais, rascunho/drag/resize/cancelamento/salvamento e ledger preservado. |
| 5 — Permissões | PASS | Backend/UI owner/delegado/atendente em homologação, grant/RLS conferidos em produção. |
| 6 — Estados | PASS | Casos e limites repetidos; 12 pendentes e 1 ativo em produção são estado válido. |
| 7 — Alertas | PASS | Regras existentes preservadas; produção amarelo para 6 entre mínimo 5 e meta 10. |
| 8 — Imagens | PENDING | Owner e arquivo/hash PASS; foto do atendente publicado aguardando login. |
| 9 — Biblioteca/admin | PASS | Rename/status/delete, confirmação, proteção de uso e recuperação de falha PASS; UI publicada inspecionada. |
| 10 — Modal | PASS | Conteúdo e foto owner publicados, fluxo com toque e lotes/FEFO em homologação. |
| 11 — Reposição | PASS | Suítes locais novamente aprovadas e cotação real homolog; transação remota da auditoria anterior ainda válida. |
| 12 — Venda/saída | PASS | Suítes locais novamente aprovadas; ensaio concorrente remoto anterior preservado, RPCs não alteradas. |
| 13 — Unallocated | PASS | Invariante por lote e 184 = 178 + 6 conferidos antes/depois. |
| 14 — Proteções estruturais | PASS | Regressões repetidas; sem alteração de schema/RPC estrutural. |
| 15 — Histórico | PASS | 687, atores/lotes/pais e fingerprint preservados. |
| 16 — Inventário | PASS | Regressões repetidas; fechamento concorrente real artificial da auditoria anterior continua válido. |
| 17 — FEFO | PASS | Regressões e plano real de homologação repetidos; sem mudança de regra. |
| 18 — Performance | PASS | 100 blocos DOM 40–48 ms; mapa 52 mil movimentos 850 ms; 13 blocos reais homolog 239–331 ms na última amostra. |
| 19 — Tablet | PASS | 1280×800 / 1024×768, modal/editor/biblioteca e toque nos testes repetidos. |
| 20 — Mobile | PASS | 390/360px, biblioteca/admin e fluxo completo delegado em homologação a 360px. |
| 21 — PWA | PENDING | Software v15 PASS em homologação e upgrade v11/v12/v14 repetido; ciclo publicado do atendente pendente. Instalação manual é PENDING NÃO BLOQUEANTE. |
| 22 — Storage | PASS | Privado PNG/JPEG/WebP 2 MiB, 19 objetos/catalogados, zero referências quebradas ou pendências. |
| 23 — Segurança | PASS | Audit sem achados; 41 security/25 protection; novos endpoints sem anon e sem DML direto. |
| 24 — Consistência | PASS | Todos os fingerprints desta rodada iguais antes/depois, incluindo produtos já com POTY corrigido. |
| 25 — Operação equipe | PASS | Regressões de reposição/saída atualizam mapa sem telas técnicas extras; nenhuma escrita fake em produção. |
| 26 — Owner | PASS | Administração corrigida sem novo poder de estoque; delegação/revogação anteriores e regressões válidas. |
| 27 — Erros | PASS | Nome inválido, conflito, em uso, RLS, arquivo ausente e falhas intermediárias com recuperação testados. |
| 28 — Docs | PASS | Causa, SQL/hash/backup, semântica, testes, intervenção e estado de aceite registrados. |
| 29 — Pendências | PASS | Dois bloqueios funcionais corrigidos; smoke de atendente pendente; instalação manual não bloqueante. |
| 30 — GO final | PENDING | Não emitir aprovação integral antes de confirmar o smoke de leitura publicado. |

## Auditoria inicial — histórico no código a0448a0

## Alvo, Git e limites

- Código em main, origin/main e Pages: `a0448a07f0f720a64b3521a65f55a118ae4e4a99`.
- Branch desta auditoria: `codex/fridge-final-validation`, criada desse SHA depois de fetch e conferência dos três refs. Zero commits locais pendentes no início.
- Working tree versionado inicialmente limpo. Preservados os cinco arquivos não rastreados: config local de cópia e quatro auxiliares de backup. Não foram lidos segredos do config nem incluídos arquivos privados no commit.
- Cloudflare respondeu HTTP 200; os 18 arquivos públicos conferem com o build por allowlist, normalizando somente CRLF. Configuração pública publicada aponta para o projeto de produção esperado; nenhum config local foi lido pelos testes.
- Supabase de produção `wddbhtxkbrhsjewuaekv` e homologação `zthorgwmnigwceobbkoj` reportaram ACTIVE_HEALTHY.
- Produção recebeu apenas leituras e navegação. Sem migration, alteração de usuário/capability, vínculo de foto, layout, movimento, limpeza, restore, merge, tag ou deploy nesta rodada.
- As mudanças locais são testes, correções de fixtures antigas e documentação. Não houve alteração do código executável do produto. Os ensaios remotos de escrita ocorreram exclusivamente no projeto descartável com contas e dados artificiais.

## Bloqueios do aceite solicitado

1. **Administração da biblioteca incompleta.** O frontend `image-library.js` oferece consulta, busca, upload, escolha/reutilização e desvinculação. Não oferece renomear, desativar, reativar ou excluir definitivamente, nem confirmação de exclusão. No backend existem register/list/set/archive; arquivamento é protegido, mas não há um fluxo completo de administração na UI. Não se deve chamar isso de PASS apenas porque a policy de DELETE existe. Registro idempotente pode reativar conteúdo por novo envio, o que não equivale à ação administrativa solicitada. Implementar esses fluxos seria expansão funcional relevante, fora da rodada de auditoria; permanecem requisitos não atendidos do Gate 9.
2. **Vínculo quebrado de POTY 2L em produção.** Há um produto com image_path, mas seu objeto não existe e o caminho não está no catálogo. O reload autenticado mostra placeholder no bloco e no modal. É necessário o owner escolher explicitamente a imagem correta da biblioteca e salvar o vínculo, ou restaurar o arquivo original sob procedimento autorizado. Não associamos pelo nome nem executamos limpeza/reparo automático. O gate de imagem real desse produto continua FAIL.

A aprovação anterior da importação registrou 20 itens, incluindo uma foto legada. O baseline desta auditoria já começou com 19 objetos, 19 itens ativos, todos com hash, e zero itens legados. O nome catalogado Coca Lata substitui a denominação histórica 17.png. Não há evidência suficiente para atribuir essas mudanças a um ator ou a esta auditoria. A ausência atual da foto legada é fato verificado; sua causa não foi determinada. Todos os fingerprints ficaram estáveis entre início e fim desta rodada.

## Matriz dos 30 gates

PASS indica evidência no ambiente declarado; não implica ter executado escrita em produção. FAIL é requisito não atendido; PENDING é validação ainda não realizada.

| Gate | Resultado | Evidência curta |
|---|---|---|
| 1 — Git | PASS | main/origin/main/HEAD iniciais iguais a a0448a0; arquivos locais preservados; branch isolada. |
| 2 — Produção | PASS | ACTIVE_HEALTHY; HTTP 200; config correta; 18/18 arquivos; shell v14 e bucket existentes. |
| 3 — Modelo físico | PASS | Metalfrio 3 níveis/5 blocos; Imbera 4/8. Produção após reload; homologação após logout/login, reload offline e reconexão nos três papéis. |
| 4 — Editor | PASS | RPC/UI artificiais: nome, produto, capacidade, geometria, drag/resize, salvar e descarte de rascunho; ledger preservado pela edição. Owner de produção abriu editor sem salvar. |
| 5 — Permissões | PASS | Owner, delegado e atendente autenticados em homologação; UI e RPC/RLS. Concessão/revogação e bloqueios em fixtures. Nenhuma permissão real alterada. |
| 6 — Pendente/pronto/ativo | PASS | Produto/capacidade ausentes bloqueiam entrada; prontidão e ativação derivadas de configuração/ledger; texto e ícone além da cor. |
| 7 — Alertas | PASS | Limites de mínimo/meta testados; quatro tons no DOM; pendência cinza; regra detalhada abaixo. |
| 8 — Imagens | FAIL | Biblioteca assinada funciona; placeholder e erro de arquivo testados. Foto atualmente vinculada ao POTY 2L não existe. |
| 9 — Biblioteca/administração | FAIL | Busca/upload/reutilização/troca/desvinculação PASS; rename/desativar/reativar/delete/confirmar na UI ausentes. Proteção backend de objeto em uso PASS. |
| 10 — Modal operacional | PASS | Nome, quantidade, mínimo, meta, capacidade, ocupação, seco, não alocado, posição, lotes/validade; FEFO no diálogo de reposição. Imagem do POTY depende do Gate 8. |
| 11 — Reposição | PASS | API real homolog: dois lotes FEFO, limite pelo seco, plano parcial, débito/crédito, retry idempotente; UI artificial confirma atualização. |
| 12 — Venda/saída | PASS | API homolog divide entre slots; concorrência confirma uma venda; retry preserva evento; testes locais cobrem lotes, perda/retorno/ajuste e histórico. |
| 13 — Unallocated | PASS | 184 = 178 + 6; zero violações por lote e zero partições negativas. Suporte legacy preservado nos testes. |
| 14 — Proteções estruturais | PASS | Fixtures recusam desativação com saldo, produto incompatível, capacidade insuficiente e mudança de pai; realocação usa ledger. |
| 15 — Histórico | PASS | 687 movimentos; atores, lotes, timestamps e pais válidos; histórico UI agrupa venda split e mostra origem/destino; fingerprint igual. |
| 16 — Inventário | PASS | Legacy local; espacial local e API homolog com conflito, recontagem, revisão e fechamento concorrente idempotente. |
| 17 — FEFO | PASS | Ordem validade/criação/lote; múltiplos lotes e vencidos; plano do servidor conferido no navegador e API homolog. |
| 18 — Performance | PASS | 100 blocos DOM em 43–48 ms; 52.000 movimentos, mapa 910 ms, histórico 26 ms, reposição 12 ms nesta máquina. Sem teste de carga em produção. |
| 19 — Tablet | PASS | Emulação Chromium com toque: 1280×800 e 1024×768, mapa/modal/editor/biblioteca e busca; sem overflow horizontal global. |
| 20 — Mobile | PASS | Emulação 390px e 360px: navegação, toque, modal contido, biblioteca, editor; reposição/saída confirmadas em 390px artificial. |
| 21 — PWA | PENDING | Online/offline/reload/cache/upgrade/reconexão e acesso PASS; instalação manual via sistema operacional não executada nesta rodada. Sem cache de fotos privadas/API. |
| 22 — Storage | FAIL | Privado, MIME/limite/policies/isolamento PASS; zero órfãos sem catálogo ou vínculo, mas um vínculo de produto aponta para objeto ausente. Sem limpeza. |
| 23 — Segurança | PASS | Secret audit sem achados; security 41 e production-protection 25; RLS em todas as tabelas públicas guigs; avisos triados abaixo. |
| 24 — Consistência produção | PASS | Baseline inicial/final idêntico para ledger, lotes, produtos, layout, catálogo, objetos, memberships e estado de identidade Auth selecionado. |
| 25 — Equipe | PASS | Atendente artificial abre alerta/modal, consulta seco, repõe com FEFO, retorna e vê quantidade/status atualizados. Termos técnicos concentrados nos detalhes. |
| 26 — Owner | PASS | Fixture configura bloco, associa imagem, salva, delega/revoga; capacidade e produto explícitos. Não usado estoque real para o ensaio. |
| 27 — Erros | PASS | Testes cobrem produto/capacidade pendentes, tipo/tamanho, arquivo ausente, RLS, insuficiência, excesso, conflito/revision/CAS, imagem em uso e offline. Ausência de UI administrativa continua Gate 9. |
| 28 — Documentação | PASS | Cinco documentos revisados; avisos de precedência e estado atual adicionados; histórico preservado. |
| 29 — Pendências | PASS | Bloqueios de aceite separados de melhorias futuras e limites de validação. |
| 30 — GO final | FAIL | Os Gates 8/9/22 impedem aprovar o escopo integral. Nenhuma liberação nova ou alteração de produção foi executada. |

## Matriz consolidada de aceite

| Item | Resultado | Evidência |
|---|---|---|
| mapa | PASS | 2/7/13, operação padrão, toque/teclado e reload. |
| editor | PASS | Rascunho, drag/resize e persistência em fixture, sem estoque. |
| imagens | FAIL | POTY 2L com referência ausente; fallback seguro. |
| biblioteca | FAIL | Núcleo de busca/envio/reutilização/desvinculação PASS; administração abaixo ausente. |
| rename | FAIL | Sem ação/RPC administrativa de renomeação. |
| deactivate | FAIL | RPC archive protegida existe; ação de UI ausente. |
| reactivate | FAIL | Sem ação explícita de UI; reenvio idempotente não substitui administração. |
| delete | FAIL | Policy protege uso; não há exclusão definitiva com confirmação na UI. |
| permissões | PASS | Owner/delegado/atendente, UI + backend artificial e real homolog. |
| modal | PASS | Informações, acessibilidade e ações; foto pendente no produto afetado. |
| replenish | PASS | FEFO, limites, retry e atualização. |
| FEFO | PASS | Plano multi-lote e validade. |
| sale | PASS | Multi-slot, concorrência e idempotência. |
| inventory | PASS | Legacy/local e espacial/PostgREST. |
| ledger | PASS | Eventos auditáveis, 687 preservados em produção. |
| invariant | PASS | Por lote, sem negativos ou referências espaciais incompatíveis. |
| desktop | PASS | Navegação, editor, modal, biblioteca. |
| tablet | PASS | 1280×800 e 1024×768 emulação touch. |
| mobile | PASS | 390/360px emulação touch, sem overflow global. |
| PWA | PENDING | Software PASS; instalação manual não executada. |
| Storage | FAIL | Contrato seguro PASS; uma referência quebrada. |
| performance | PASS | Tempos locais abaixo dos budgets existentes. |
| security | PASS | Sem segredo Git ou falha de isolamento demonstrada; hardening pendente. |
| docs | PASS | Estado atual registrado e separado das aprovações históricas. |
| produção | PENDING | Saúde/build/consistência PASS; aceite integral depende de imagens/administração. |

## Regras operacionais conferidas

Configuração PENDENTE se produto ou capacidade estiver ausente. PRONTO se completo, sem saldo ou ativação anterior daquele produto; ATIVO com saldo ou is_activated. Para bloco configurado: quantidade zero = VAZIO/vermelho; abaixo do mínimo = CRÍTICO/vermelho; entre mínimo inclusive e meta exclusive = ATENÇÃO/amarelo; a partir da meta = OK/verde. Cinza é configuração incompleta. Os testes cobrem os limites exatos. A capacidade limita entrada e ocupação; não substitui a meta na regra de alerta. A sugestão de reposição usa déficit até min(meta, capacidade), limitado pelo seco elegível e FEFO do servidor. A transação revalida plano, permissões, capacidade e saldo.

Produção tem um bloco ativo (POTY 2L, 6 unidades, mínimo 5, meta/capacidade 10) e 12 pendentes. Pendência física é estado válido, não um blocker por si só; não inventar capacidades, produto ou estoque para completar a tela. No modal de produção, o produto afetado tinha seco elegível zero: não tentamos repor para forçar teste.

Bucket `guigs-product-images`: privado, PNG/JPEG/WebP, 2.097.152 bytes. SELECT por membro ativo da loja; INSERT para owner/capability; UPDATE com USING/WITH CHECK e proteção de objetos catalogados imutáveis; DELETE somente autorizado, sem produto associado e catálogo inativo. Assinaturas de 300 segundos e namespace por shop. Sem service_role no frontend. Troca funcional usa novo vínculo, preservando o objeto compartilhado. Fotos privadas não entram no cache PWA. Não confundir os 19 itens de biblioteca sem associação atual com lixo: são conteúdo reutilizável, não candidatos a limpeza automática.

## Execuções desta rodada

- `node scripts/test-release.cjs`: 1.206 verificações / 14 suítes PASS, nenhuma omitida, cerca de 108 s. Inclui security, production-protection, navegador, build, inventário e performance legacy.
- `node scripts/test-v17.cjs`: 466 verificações / 11 suítes PASS antes da extensão responsiva. Depois, `node tests/fridge-editor-browser.cjs`: 157 PASS (antes 132); 25 verificações novas para biblioteca/editor nos quatro viewports e preservação do ledger. Total das suítes espaciais com essa extensão: 491; as dez suítes inalteradas não foram repetidas sem necessidade.
- `node tests/homologation-target.cjs`: 13 PASS.
- `node scripts/homologation/map-visual-browser.cjs --reuse-fixture`: 49 PASS; três papéis reais artificiais, imagens assinadas, biblioteca, FEFO, logout/login, PWA e mapa/ledger preservados. Não provisiona usuários novamente.
- `node scripts/homologation/image-library.cjs`: 12 PASS; formatos, idempotência, aliases, conteúdo imutável, reutilização, capability, isolamento e ledger preservado.
- `node scripts/homologation/fridge-replenishment.cjs`: 7 PASS; API real artificial.
- `node scripts/homologation/fridge-operations.cjs`: 6 PASS; API real artificial, duas vendas concorrentes.
- `node scripts/homologation/fridge-inventory.cjs`: 8 PASS; loja artificial dedicada conferida por nome, fechamento concorrente idempotente.
- Fixtures antigas de saída/inventário passaram a declarar capacidade 24 explicitamente, em vez de depender do antigo default anterior ao suporte a capacidade pendente. Nenhuma capacidade real foi alterada.
- Capturas de dados artificiais em pasta temporária privada externa ao Git; editor 360/1024 e modal mobile inspecionados visualmente. Emulação de dispositivos, sem afirmar ensaio em hardware físico.
- Comparação de publicação: HTTP 200, 18/18 arquivos, nenhuma diferença, aproximadamente 1.364 ms para leitura/build/comparação completa. Não é medição de latência do mapa autenticado nem benchmark de carga.
- Navegação do mapa de 13 blocos em homologação, medida do clique até o primeiro bloco disponível: owner 358 ms, atendente 251 ms, delegado 863 ms. Abertura do modal: 58/59/62 ms. Biblioteca até carregar thumbnails da fixture: 804/920/698 ms. Prévia do editor owner/delegado: 42/42 ms. Amostras únicas com navegador automatizado e rede desta máquina, não percentis nem SLA de produção.
- `node scripts/audit-repository.cjs`: 141 arquivos rastreados, 84 commits alcançáveis, 342 blobs históricos únicos, zero achados; config ignorado e não rastreado. Revisão do diff e `git diff --check` aprovadas. Security/protection repetidos após os ajustes dos testes: 41/25 PASS.

## Baseline de produção antes/depois

Sem diferença nas duas leituras desta rodada:

| Escopo | Linhas | MD5 dos registros agregados |
|---|---:|---|
| Ledger | 687 | 0470bca16323e2652e046bfe200d297c |
| Lotes | 74 | df4464a2a6364efc6a064ec0c615dd41 |
| Produtos | 20 | c36c049c412ed2b7aa180ff40518689a |
| Layout | 22 (2/7/13) | 09b4fe20d734029675c1d856fa5c3250 |
| Catálogo | 19 | b93a5bb7b0551870ece3387d8d34cbed |
| Storage | 19 | cab86b46d64cb48a5737f252fc546eda |
| Memberships | 9 | c3e8318a025dd7d073277315ff36a4ea |
| Estado de identidade Auth selecionado | 9 | 58fd0b03510e1741dbf81fa2c47bfaca |

MD5 é evidência de comparação, não hash de segurança/backup. Ledger/lotes/produtos/catálogo usam JSONB completo ordenado por id e separado por newline; memberships por shop_id/user_id; layout união JSONB ordenada pelo texto. Storage usa somente id/name/metadata/updated_at, excluindo last_accessed_at. Auth usa somente id/role/banned_until/deleted_at/email_confirmed_at: não lê senha, hash de senha, tokens ou sessões. Essa comparação não é auditoria integral de Auth e permite os logs normais de acesso da sessão.

Geladeira global 184, não alocado 178, slots 6. Zero violações do invariante por lote, partições negativas, movimentos sem lote/ator/timestamp, pais espaciais órfãos ou recebimentos em slot de produto incompatível. Dois movimentos espaciais; Activation Point já cruzado em 05/11/2026 às 10:13:05 em São Paulo, preservado. Nenhum restore/rollback de frontend v1.6 é recomendado depois desse ponto.

## Segurança e limites

Todas as tabelas públicas guigs têm RLS. As quatro RPCs de imagens não concedem EXECUTE a anon; suas checagens de identidade/membership/capability e search_path vazio foram conferidas. O advisor sinalizou nove RPCs históricas SECURITY DEFINER executáveis por anon: todas têm checagem explícita de autenticação ou membership, com busca vazia; os testes artificiais de autorização passaram. Revogar grants anônimos históricos é hardening recomendado por migration própria, sem executar alteração nesta auditoria. Ver [aviso de função pública](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

O aviso de SECURITY DEFINER executável por authenticated deve ser interpretado com as verificações de autorização, não corrigido liberando DML direto. RLS sem policy em guigs_private.spatial_commands é fechamento intencional para clientes, acessível somente pelos fluxos autorizados. A proteção de senhas vazadas do Auth está desativada; recomenda-se revisão administrativa conforme [documentação de senhas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), sem mudança automática de configuração.

O secret audit cobre arquivos rastreados e blobs alcançáveis dos últimos 100 commits, não arquivos ignorados, forks ou logs externos. Nenhuma imagem importada, dump, recovery, config privado, pgpass, .env, senha, JWT ou chave privilegiada foi adicionado ao Git. Anotações de hashes/agregados não contêm export de linhas operacionais.

Não foram executados instalação PWA pelo sistema operacional, teste em tablet físico, nova sessão de atendente real de produção ou logout/login real de produção. Os três papéis passaram esses ciclos no ambiente de homologação e o owner existente foi verificado em produção após reload. Escritas de layout/imagens, saídas, inventários e delegações reais de produção não foram usadas para testes.

## Caminho para fechar e primeiro dia

Para fechar o aceite integral: corrigir explicitamente o vínculo de POTY 2L; entregar e homologar as ações administrativas faltantes em trabalho próprio; repetir os Gates 8/9/22 e o smoke final do build correspondente. Instalação PWA manual permanece PENDING, sem evidência de falha do software. Não apagar arquivos ou alterar estoque para obter um PASS.

Melhorias futuras não bloqueantes: divisão/mesclagem atômicas de blocos, analytics, IoT/sensores/temperatura, automações e apresentação menos técnica do UUID no modal. Não foram implementadas. O ID aparece nos detalhes, não sobrecarrega o mapa.

Após resolver os bloqueios, orientar o primeiro turno a usar somente blocos configurados com capacidade física contada; reconhecer cinza como pendência e amarelo/vermelho como atenção de saldo; conferir seco/FEFO no modal antes de confirmar reposição; esperar sincronização, sem repetir como nova operação quando houver dúvida de rede; manter estoque legado não alocado até alocação real autorizada. Owner deve conferir as primeiras operações no histórico e o invariante. Nenhum saldo deve ser preenchido a partir de foto.

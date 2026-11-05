# Mapa visual e experiência operacional

Este documento preserva a aprovação histórica do redesign. O estado atual consolidado está em [validação final](VALIDACAO_FINAL_MAPA.md), de 05/11/2026: código executável 587931a, shell v15, 19 imagens e administração da biblioteca publicada. Os números e versões das seções históricas abaixo não substituem essa leitura atual.

## Gates 0 e 1 — auditoria e inventário

Branch codex/fridge-map-visual-redesign, criada da main/origin/main no SHA 417299bf45e6853c71b04e1c826bbaf4a71dbecf. Working tree versionado limpo no início. Arquivos locais privados e auxiliares de backup não versionados foram preservados.

Baseline somente leitura em 05/11/2026. Produção tem 2 geladeiras, 7 níveis e 13 blocos. O estado real já cruzou o Activation Point em 05/11/2026 às 10h13min05s (America/Sao_Paulo), com transferência espacial de 6 unidades do seco para um slot. Esse fato é anterior ao redesign e difere da premissa do pedido. Nada foi revertido ou movimentado nesta rodada.

| Medida | Baseline |
|---|---|
| Ledger | 687 linhas, fingerprint 0470bca16323e2652e046bfe200d297c |
| Geladeira global | 184 |
| Não alocado | 178 |
| Soma dos slots | 6 |
| Movimentos espaciais | 2 |
| Activation Point | já cruzado, preservar |
| Estrutura | 2 / 7 / 13, fingerprint 09b4fe20d734029675c1d856fa5c3250 |
| Storage | guigs-product-images privado, PNG/JPEG/WebP, 2 MiB, 1 objeto, 4 policies |

Invariante inicial 184 = 178 + 6.

UI existente concentrada em fridges.js e CSS/markup de index.html. createFridgesUI coordena modos, editor, fotografias, operações, distribuição e reposição. renderMap misturava cards com atributos, meter, mínimo/meta, lotes e botão Repor. renderForm exige percentuais crus. Há diálogos separados para reposição, movimentação e distribuição, mas não havia diálogo de detalhes do bloco.

Dados vêm da RPC guigs_get_fridge_map, contendo fridges/shelves/slots/unallocated/dry e can_manage_layout. Produtos vêm do contexto já carregado. Sem coluna SKU comercial no contrato atual, usar o identificador cadastrado explicitamente como ID, sem inventar SKU. As imagens usam URLs assinadas de 300 segundos, limitadas à origem Supabase. O backend permanece autoridade para membership/capability, FEFO, concorrência, idempotência e saldos.

São mudanças visuais a composição de geladeira, tokens, cards compactos, modal informativo e prévia interativa do editor. Todas as gravações continuam pelas RPCs existentes e exigem confirmação do usuário. Esta rodada não exige migration, mudança de RLS, Auth, Storage ou regra de estoque. Não executar edição estrutural ou movimentação na produção durante o smoke.

## Gate 2 — linguagem visual

Identidade grafite, bordô Guig's e tons frios no vidro. Tokens de shell, prateleira, hover, seleção, edição e quatro estados. Cinza para pendência, verde para OK, amarelo para ATENÇÃO e vermelho para CRÍTICO/VAZIO. A classificação usa fridgeSlotConfiguration e fridgeSlotState existentes, sem outra regra de saldo. Configuração PRONTO/ATIVO permanece no modal e não altera o alerta de quantidade.

Operação é a entrada padrão. Geladeiras verticais com moldura, vidro e prateleiras. Blocos mostram foto proporcional, nome curto, quantidade leve quando configurados e ícone/label de status. Detalhes e lotes vão para o modal. Quantidade zero configurada continua crítica conforme regra atual. Capacidade ou produto ausentes permanecem cinza, sem ocupação fictícia.

## Plano de validação

Protótipo funcional no próprio DOM com fixtures artificiais antes de produção. Desktop, tablets 1280x800 e 1024x768 e mobile 390/360. Testar toque/teclado, foco/escape, todas as cores e estados de configuração, imagem/placeholder, modal, FEFO existente, edição sem saldo, offline/reload/cache, reduced motion e volume. Regressões completas, auditoria de segredos e diff. Homologação antes do GO. Produção somente depois dos gates e backup/baseline privados exigidos.

## Estado

Gates concluídos. MAPA VISUAL INTERATIVO APROVADO. Publicação e smoke de produção aprovados, com saldos, ledger e estrutura preservados.
## Visão operacional, modal e interação

Operação continua como modo padrão. As molduras grafite, vidro claro, níveis horizontais e base identificam as expositoras. O DOM preserva a hierarquia geladeira/nível/bloco. Em espaço estreito, os blocos ganham áreas confortáveis de toque; sua geometria gravada não é alterada. O nome completo e o caminho físico continuam disponíveis no nome acessível e no modal.

Cada bloco é um botão nativo, abre por toque, Enter ou espaço e anuncia produto, status, quantidade e localização. Estado tem cor e ícone. O modal fecha com Escape ou botão, devolve foco ao bloco, e concentra foto maior, configuração pendente/pronto/ativo, identificação cadastral, saldo, mínimo, meta, capacidade, ocupação, seco elegível, não alocado e lotes. Sem produto/capacidade não há meter nem percentuais falsos. Repor fica visível no rodapé enquanto o conteúdo interno pode rolar. Os lotes seguem a ordem fornecida pelo backend e vencidos são identificados. A cotação FEFO e confirmação continuam no diálogo de reposição existente.

O botão de saída do modal usa o mesmo diálogo e mecanismo de operações existente. Ajuste aparece somente no papel owner. Usuários sem edição não recebem ações estruturais. O detalhamento não grava nem cria reserva. Dados ausentes ou bloco desativado no reload fecham o modal com aviso. Offline mantém o último mapa em memória, sinaliza defasagem e bloqueia mutações.

Fotos preservam proporção com object-fit contain, decodificação assíncrona e lazy load. URLs assinadas atualizam apenas os elementos de foto, conservando foco dos botões. Falhas voltam ao placeholder de garrafa. As fotos privadas e respostas de Auth/API permanecem fora do cache PWA.

## Editor separado

O editor usa paleta quente e prévia estrutural independente da operação. Selecionar geladeira, nível ou bloco na prévia abre o formulário correspondente. Sliders e botões Antes/Depois são a interação principal de posição/tamanho/ordem. Percentuais exatos ficam recolhidos em Valores precisos e ordem. Níveis podem ajustar altura e posição visual. Blocos podem mudar de pais pelos seletores existentes, sujeitos às regras de ocupação do backend.

Arrastar e redimensionar o bloco selecionado funciona dentro do nível, com pointer capture e limites normalizados. As mesmas ações têm alternativa por teclado e sliders. São apenas rascunhos, persistidos por Salvar layout e pela RPC existente com revision. Não há auto-save, alocação ou modificação de estoque por movimento visual. A duplicação prepara um bloco novo pendente, sem produto, capacidade ou escrita até salvar. Desativação mantém confirmação e proteção de saldo do servidor.

Divisão e mesclagem ficam planejadas. UX prevista para divisão: selecionar bloco vazio, escolher 2 ou 3 partes, revisar prévia e confirmar. Uma futura RPC atômica deverá verificar revisions, permissões e ausência de saldo, criar partes sem inferir produto/capacidade e só então substituir a estrutura original, tudo na mesma transação. Mesclagem também exige blocos vazios adjacentes, sem produzir movimentos. Não encadear várias RPCs não atômicas nem expor um botão que possa deixar divisão pela metade. Isso exigiria intervenção de backend fora desta refatoração visual.

## Responsividade e acessibilidade

Duas expositoras lado a lado quando há espaço. Mobile empilha uma por linha. Tablets 1280x800 e 1024x768 foram testados, além de 820px e mobile 390/360px, incluindo toque real do navegador, overflow e modal contido no viewport. Blocos mantêm alvo mínimo de 44px. Detalhes rolam sem esconder a ação principal. Status possuem texto/ícone, foco visível e identificação acessível. Hover suave, sem animação contínua; prefers-reduced-motion elimina transformação e transição.

## Gates 3 a 12 — evidências

- Protótipo funcional validado antes de publicação, somente com fixtures artificiais. Capturas locais de desktop, tablets, editor e modal mobile foram inspecionadas visualmente.
- Regressão geral: 1.205 verificações, sem suítes omitidas. Inclui segurança, build e protection. Sem alterações de backend, migration ou RLS.
- Regressão espacial: 415 verificações. O navegador inclui 125 controles de pendência, alerta, modal, foco/escape, permissões, imagem e fallback, edição/duplicação em rascunho, reposição, idempotência, operações, FEFO e responsividade. As regras de saldo continuam nas mesmas RPCs.
- Volume no navegador: 100 blocos artificiais renderizados com leitura em aproximadamente 47–48 ms nesta máquina. Budget testado abaixo de 3s. Consulta espacial com 52.000 movimentos também passou na suíte existente. Nenhuma biblioteca nova no frontend.
- PWA passa para shell v13, com upgrade/limpeza dos caches v11/v12, preservação de cache alheio, offline/reload/reconexão e prevenção de respostas redirecionadas. Testes de imagens e reduced motion aprovados.
- Homologação real: 38 controles no projeto zthorgwmnigwceobbkoj. Build em servidor loopback isolado, ligado ao Supabase descartável; não foi criada hospedagem pública adicional. Loja 2/7/13 e três usuários artificiais novos. Owner, atendente comum e delegado autenticados pela interface, fotos privadas e FEFO reais, permissões, PWA/offline/reload/reconexão validados. Durante o smoke o navegador aceita apenas Auth e APIs de leitura/assinatura, bloqueando qualquer mutação de dados. Mapa e ledger integrais iguais antes/depois. Fixture fica preservada e pode ser reutilizada com --reuse-fixture, sem reset de usuários existentes. Credenciais artificiais e relatório ficam no cofre temporário privado externo ao Git.

## Gate 13 — preparação de produção

Backup executado manualmente pelo administrador e verificado. Pacote privado pre-visual-2026-11-05_13-43-38-06128adc, archive recovery.dump de 385.603 bytes. SHA-256 4BE56824679A3E462C042370C90BB72BCD2AF47F1743D83A88DB848C1967361F. Manifesto/snapshot e baseline conferidos. O dump não contém os bytes de Storage; esta rodada não modifica objetos, bucket ou vínculos de fotos. O arquivo original do responsável permanece a fonte do objeto já provisionado.

Auditoria final de diff e segredos aprovada. Smoke real de owner e atendente executado estritamente com leitura e navegação, com toda gravação de estoque/layout bloqueada no navegador de validação. Agregados/fingerprints do baseline comparados e idênticos antes e depois. Nenhuma tag criada. Código anterior v1.7 é compatível com o backend atual; eventual compensação limita-se ao frontend v1.7 conhecido e não reverte ledger. A v1.6 não é fallback após Activation Point.

## Resultado de produção

Código publicado no SHA d4e13095304ddd19e2431fcdaf867768329a940a. Os 17 arquivos públicos conferem com o artefato de produção revisado. Nenhuma migration, RPC, policy ou coluna foi alterada nesta rodada.

Owner real aprovado em 18 controles e atendente comum real em 16, com membership efetiva conferida na resposta autenticada. Duas geladeiras, sete níveis, treze blocos, foto privada, modal por toque, ocupação e lotes no modal, restauração do foco, permissões, reload e PWA v13 confirmados. Owner também abriu a prévia estrutural e o painel administrativo sem salvar. Nenhuma chamada de mutação foi tentada no navegador do smoke. Não houve erro JavaScript. Delegate validado na homologação real, sem conceder ou modificar capabilities em produção.

Baseline final idêntico ao inicial: geladeira global 184, unallocated 178, soma dos slots 6, 687 movimentos, fingerprint do ledger 0470bca16323e2652e046bfe200d297c, duas linhas espaciais, Activation Point já cruzado e preservado. Estrutura com fingerprint 09b4fe20d734029675c1d856fa5c3250 e um objeto de imagem preservados. Não foram feitos movimentos de teste ou alterações de configuração na produção.

Os fingerprints acima são da leitura agregada desta rodada: MD5 da concatenação dos registros JSONB completos do ledger ordenados por id, separados por newline; para estrutura, união dos registros JSONB de geladeiras/níveis/blocos, ordenados pelo texto. O baseline.csv do backup usa a consulta oficial de 13 escopos do pré-release e deve ser comparado usando sua própria definição, sem misturar algoritmos.

| Item | Resultado | Evidência / escopo |
|---|---|---|
| Branch | PASS | codex/fridge-map-visual-redesign, base 417299b |
| Baseline | PASS | atual conferido antes/depois, com Activation Point já cruzado |
| Novo visual | PASS | protótipo e revisão visual, HTML/CSS/DOM |
| Geladeira | PASS | moldura, vidro, base, hierarquia preservada |
| Prateleiras | PASS | níveis visuais e rascunhos de altura/posição |
| Slots | PASS | botões compactos com alvo de toque |
| Status | PASS | regras existentes, quatro cores, ícone/texto |
| Imagens | PASS | contain, lazy load, assinatura privada e fallback |
| Modal | PASS | informações operacionais, foco e ações visíveis |
| Repor | PASS | fluxo existente, cotação no servidor e confirmação |
| FEFO | PASS | testes locais e plano real de homologação |
| Editor | PASS | separado, prévia, controles simples e campos precisos recolhidos |
| Drag/resize | PASS | mesma prateleira, rascunho com salvamento explícito |
| Owner | PASS | homologação e 18 controles reais em produção |
| Attendant | PASS | homologação e 16 controles reais em produção |
| manage_fridge_layout | PASS | delegado real artificial de homologação e testes de revogação |
| Desktop | PASS | visual e navegação por teclado/mouse |
| Tablet | PASS | 1280x800, 1024x768 e 820px, toque e modal |
| Mobile | PASS | 390/360px, empilhamento, alvos e modal |
| PWA | PASS | v13, limpeza v11/v12, offline/reload/reconexão |
| Performance | PASS | 100 blocos em 47–48 ms na medição local; teste de 52 mil movimentos existente preservado |
| Testes | PASS | 1.205 gerais + 415 espaciais + 13 de alvo |
| Homologação | PASS | 38 controles reais com fixture artificial e zero drift do ledger |
| Produção | PASS | 17 arquivos conferidos e 34 controles reais somente leitura |
| Saldo preservado | PASS | 184 = 178 + 6, sem diferença |
| Ledger preservado | PASS | 687 registros e fingerprint idêntico |

Divisão e mesclagem permanecem planejadas conforme a opção permitida no pedido, dependendo de futura operação atômica de estrutura. Nenhum controle incompleto foi publicado. Não há blocker aberto para o escopo aprovado de redesign.

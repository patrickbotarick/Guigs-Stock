# Biblioteca de imagens de produtos

Estado atual e aceite estão na [matriz consolidada](VALIDACAO_FINAL_MAPA.md). A importação e a auditoria anteriores são preservadas abaixo como histórico. A correção administrativa descrita nesta seção substitui as limitações da versão a0448a0.

## Correção dos dois bloqueios de aceite — 05/11/2026

Causa raiz da UI ausente: a0448a0 contém somente o seletor de imagens. Não havia componente administrativo oculto, condição de permissão incorreta ou build antigo. O backend tinha register/list/set/archive, mas archive recusava imagem em uso e não havia UI nem fluxo de exclusão com confirmação/recuperação de falhas.

A entrada **Gerenciar imagens**, no mesmo modal da biblioteca, fica disponível para owner e manage_fridge_layout. Atendente comum mantém somente leitura. Administração lista thumbnail, nome, estado e produtos vinculados; filtros Todas/Ativas/Inativas/Exclusões pendentes. Renomear valida trim, 1–160 caracteres e recusa controles; muda somente display_name, preservando path/hash/original/MIME/bytes. Conflito de nome/estado exige nova leitura antes de gravar.

Desativar tem confirmação e preserva objeto e vínculos atuais. A imagem deixa o seletor ativo, mas continua renderizando nos produtos que já a utilizam. Reativar exige objeto existente e devolve a imagem à seleção. O backend protege também caminhos legados contra nova associação a imagem inativa.

Excluir abre modal próprio com thumbnail, nome, alerta de irreversibilidade, Cancelar e botão destrutivo Excluir permanentemente. Em uso, o modal informa os produtos, bloqueia a confirmação e oferece Desativar. O backend repete a checagem sob o lock por loja usado por associação, catálogo e Storage. A UI não exclui imagem real como teste em produção.

Migration aditiva `20261105182536_image_library_administration.sql`, SHA-256 `675D7DABE13DBD3F61242DC3C7A3EF19201EFAC1481EE60004E0EC6A131E27F7`. Cinco RPCs novas: guigs_list_image_admin, guigs_edit_product_image, guigs_begin_image_delete, guigs_finish_image_delete e guigs_cancel_image_delete. EXECUTE apenas authenticated, autenticação/capability real por shop, search_path vazio e nenhum DML direto de cliente. A tabela privada guigs_private.product_image_deletions tem RLS sem policy/grant para clientes.

Exclusão distribuída: begin confere ausência de vínculos e move atomicamente o registro do catálogo para uma pendência privada, reservando o caminho. A API oficial Storage remove o objeto; finish só encerra a pendência após conferir ausência em storage.objects. Nenhum DELETE SQL é usado para remover metadados de Storage. Enquanto pendente, novos registros, uploads, sobrescritas e associações ao caminho ficam bloqueados. A administração continua mostrando a pendência, não um item selecionável com arquivo ausente. Se o arquivo ainda existe, Cancelar exclusão pendente restaura o catálogo; se já foi removido, só Concluir exclusão está disponível. Repetição é idempotente. Falhas não geram limpeza automática nem órfãos silenciosos.

O CDN pode responder conteúdo previamente armazenado por um curto intervalo depois do DELETE; o ensaio confere remoção com GET autenticado sem cache e consulta do backend. A PWA não armazena imagens/API. Shell v15 remove os caches anteriores e mantém leitura de nome/status pela API, sem cache PWA. Ver [schema de Storage](https://supabase.com/docs/guides/storage/schema/design) e [invalidação do CDN](https://supabase.com/docs/guides/storage/cdn/purge-cdn-cache).

POTY 2L: o vínculo já estava corrigido no primeiro SELECT desta rodada; não foi regravado nem inferido pelo código. Produto 5c0f46a1-56eb-46f3-9987-43edb4d6f8c1 aponta para o catálogo 48f878ca-69cd-4b98-9dcf-7056f43056ef, caminho `094582e6-29f6-4dda-b631-cdc7b229f5dc/library/cfdf4638184b780f1a8a3d16a2ebacb048ac04424a41c21c680ae366d7e3cc89.png`. Objeto existente, original local Poty 2L.png preservado com o mesmo SHA-256, e inspeção visual confirma guaraná Poty 2L. O modelo usa image_path no produto; não existe coluna image_id vinculada. O id acima é obtido por correspondência do path no catálogo.

Auditoria de órfãos somente leitura: zero registros sem objeto, zero objetos sem catálogo, zero vínculos sem catálogo/objeto e zero imagens inativas em uso no baseline atual. Uma imagem inativa em uso é permitida por este contrato e não seria classificada como órfã. Os 19 arquivos sem vínculo individual são a biblioteca reutilizável, não lixo. Nenhuma limpeza executada.

Validação: 1.206 controles gerais; 553 espaciais em 12 suítes, incluindo 50 de administração SQL/RLS e 168 de navegador/editor. Homologação administrativa real: 52 controles, owner e delegado, UI de rename/reload, desativação vinculada, reativação, confirmação/cancelamento/delete e duas falhas intermediárias injetadas. Atendente e cross-shop negados nas cinco RPCs. As exclusões usaram somente arquivos artificiais. PWA e três papéis conferidos pelo smoke real de homologação; instalação manual permanece PENDING NÃO BLOQUEANTE.

Backup manual novo: pre-image-admin-2026-11-05_18-33-48-4b0c7d91, recovery.dump 404.691 bytes, SHA-256 `69A948CE9B5003A9BD37246D9BB7F3F7E6C089FB1202D4D69C60A0F6486CE1AE`. Manifesto e baseline do mesmo snapshot conferidos. Pacote privado externo ao Git; não contém bytes dos objetos de Storage. Os originais permanecem na pasta do responsável.

Estado desta preparação: homologação aprovada; aplicação da migration, publicação e smoke de produção ainda precisam ser conferidos antes do GO final. Nenhuma tag nova prevista.

## Auditoria e contrato

Branch codex/product-image-library, base 5f89010cc23b23c6d03029c46ddc5c26aae91ad3. A foto já pertencia a guigs_products.image_path e era reutilizada pelos blocos do produto. O caminho antigo incluía o UUID do produto e o CHECK não permitia reutilização entre produtos. O frontend apagava o arquivo anterior depois de substituir/desvincular. Essas restrições foram auditadas antes de editar.

A nova migration 20261105170140_product_image_library.sql adiciona catálogo e RPCs, expande de forma compatível o CHECK de image_path e mantém os caminhos legados. Não reescreve produtos, lotes, movimentos ou posições. A imagem legada é catalogada preservando seu vínculo e bytes; seu hash fica desconhecido até leitura autenticada do objeto no importador.

Bucket guigs-product-images permanece privado, com image/png, image/jpeg e image/webp, até 2.097.152 bytes. Novos caminhos são shop_uuid/library/sha256.png, .jpg ou .webp. Hash normaliza o nome físico, original_filename preserva o nome real e aliases preservam nomes adicionais de conteúdo idêntico. Não há arquivo por slot.

Catálogo guigs_product_images contém id, shop_id, storage_path, original_filename, display_name, aliases, mime_type, bytes, sha256, created_by, created_at e active. Há unicidade por loja/path e loja/hash, RLS e SELECT autenticado somente para membros ativos da loja. Escrita direta no catálogo é revogada. guigs_register_product_image valida capability, caminho, tipo/tamanho e existência real no Storage; registro por hash é idempotente. guigs_list_product_images faz busca e paginação limitada a 60 itens. guigs_set_product_image conserva CAS e produto da loja e aceita imagens ativas do catálogo para reutilização. guigs_archive_product_image recusa imagens associadas.

Owner ou manage_fridge_layout gerenciam catálogo e vínculos. Atendente comum consulta nomes e fotos, sem associação/upload/arquivamento. Nenhuma autorização usa user_metadata. RPCs têm search_path vazio e EXECUTE restrito a authenticated. Isolamento é conferido no servidor, inclusive para o namespace library.

Objetos catalogados são imutáveis para preservar SHA-256 e fotos compartilhadas. Atualização funcional significa trocar o vínculo para outra imagem, sem sobrescrever o objeto compartilhado. INSERT/SELECT continuam protegidos por membership/capability. UPDATE de objeto não catalogado mantém os guards anteriores; objeto catalogado não aceita sobrescrita. DELETE físico exige autorização de gerência, nenhum produto associado e catálogo inativo. Associação, registro, arquivamento e policy de exclusão compartilham lock transacional por loja, evitando corrida entre associação e remoção. Não foi introduzida exclusão física na UI.

## Seletor

Escolher da biblioteca está no editor e Biblioteca de imagens está no modal operacional. O seletor mostra thumbnails com URLs assinadas de 300 segundos, nome de exibição, nome original e produtos associados. Busca por nome, alias e produto é case-insensitive. Grid responsivo, paginação, seleção explícita, envio de imagem nova e remoção de associação. Atendente vê apenas a versão de consulta. Escolher imagem exige clicar em Usar imagem neste produto; importar ou enviar para a biblioteca não associa por nome de arquivo.

Upload individual também registra o arquivo no catálogo antes de associar ao produto escolhido. SHA-256 e assinatura binária validam PNG/JPEG/WebP. Conteúdo já catalogado é conferido e reutilizado; corrida de upload confere os bytes existentes em vez de fazer upsert. Remover associação preserva o arquivo e demais produtos que o utilizem. Erro de rede não provoca exclusão compensatória de imagens compartilhadas. Fotos privadas continuam fora do cache PWA. Shell v14 inclui somente o novo módulo de código image-library.js.

## Importação administrativa

Comando padrão node scripts/import-product-images.cjs faz dry-run, sem rede, SDK, login ou upload. A origem CLI é fixa em C:\Users\patrick.silva\OneDrive\SALVAR\GUIG'S\Bebidas Guigs. Sem recursão e sem seguir links de arquivos. Outros formatos são ignorados; nomes, assinatura, MIME, tamanho e SHA-256 entram no relatório. Acima do limite ou inválido é relatado por arquivo e não bloqueia o processamento dos válidos. Não existe pipeline de compressão adotado; nenhum original é otimizado ou sobrescrito.

node scripts/import-product-images.cjs --execute abre login legítimo de produção em perfil isolado do Edge. JWT fica apenas em memória. O cliente administrativo usa chave publicável e sessão owner/capability sob RLS, sem service_role, senha em arquivo, PGPASSFILE ou credencial em relatório. Projeto e loja são fixados e conferidos. O importador pode ler o objeto remoto legado da mesma loja para enriquecer seu SHA-256, sem trocar sua associação. Cada arquivo local é relido e tem hash/tamanho conferidos antes do envio. Reexecução é idempotente. Relatório de nomes/hashes/resultados fica na pasta privada temporária externa ao Git.

Dry-run real aprovado: 19 arquivos, todos PNG, 19 válidos, 0 duplicados locais, 0 recusados, 0 acima do limite, 1.991.159 bytes. Zero otimizados. O arquivo 17.png não foi usado para inferir produto. Não houve sugestões ou associações automáticas.

## Validação e implantação

- 44 controles locais da biblioteca, com PNG/JPEG/WebP artificiais, tamanho, formato inválido, SHA, duplicata, nomes com espaço/acentos/caracteres especiais, aliases, RLS, compartilhamento, desvinculação, arquivamento, isolamento, compatibilidade legada e allowlist do navegador administrativo.
- Suíte espacial com a biblioteca: 466 controles. Inclui seleção explícita de produto, associação a segundo produto, remoção preservando objeto, reload e atendente sem escrita no modal.
- API real de homologação valida importação/reexecução, PNG/JPEG/WebP, aliases, conteúdo imutável, reutilização, troca sem upload, owner/delegado/atendente e isolamento, sem movimento de estoque.
- Navegador com Supabase de homologação: 46 controles, três papéis reais artificiais, biblioteca, seleção/remoção de vínculo, thumbnails, PWA v14, offline/reload/reconexão. Mapa e ledger iguais antes/depois.
- Regressão geral: 1.206 controles aprovados. Build por allowlist, 18 arquivos públicos, sem imagens locais. Testes de alvo: 13 controles.

Backup manual conferido: pre-library-2026-11-05_17-14-27-b73cd9fc. Archive 386.027 bytes, SHA-256 3D870059429767E9ACFB606B85A58069192D067CD738D0154957C37B105F65D9. Manifesto, snapshot e hashes conferidos. Dump não contém bytes de Storage; o objeto legado é preservado e os novos originais permanecem na pasta local do responsável.

Baseline de produção: 687 movimentos, ledger 0470bca16323e2652e046bfe200d297c, global 184 = unallocated 178 + slots 6, layout 09b4fe20d734029675c1d856fa5c3250, vínculos de imagem dos produtos ed0f61b1fae260da037713adcea97a7f. Activation Point já estava cruzado, com duas linhas espaciais, e deve permanecer igual.

Aplicar apenas a nova migration exata após os gates, uma vez, com alvo conferido. Hash do SQL 1FA68893B13630E01ECCAF7880BD1BC4EC9FBC208D1DEACE365B0E951C4E82E1. Não executar db push, reset, restore ou migrations antigas. Frontend anterior continua lendo caminhos antigos e novos e enviando caminhos legados; não reverter CHECK/RPC nem apagar catálogo como rollback. Preferir correção aditiva e preservar todas as imagens e vínculos. Nenhuma tag nova é necessária.

Estado final: BIBLIOTECA DE IMAGENS APROVADA.

## Produção — importação concluída

Migration aplicada uma vez com sucesso no projeto wddbhtxkbrhsjewuaekv, preservando os fingerprints de ledger e vínculos de produto. A imagem legada foi catalogada, total de 1 item antes da importação. Código publicado no SHA 865860921dddeca45cc04f70089503def83f5025; os 18 arquivos públicos conferem com o build. Bucket permanece privado.

Login legítimo de owner e importação concluídos: 19 encontrados, 19 importados, 0 duplicados, 0 recusados e 0 otimizados. Catálogo e bucket têm 20 itens: 19 novos e a foto legada preservada. Os 19 hashes locais continuam iguais após a importação. Nenhum vínculo de produto foi criado ou alterado automaticamente.

Relatório privado: C:\Users\patrick.silva\AppData\Local\Temp\guigs-v16-private\product-image-import-1793900649344.json. Sessão com JWT somente em memória e RLS, sem chave privilegiada. O objeto legado contém JPEG com metadata histórica image/png; o importador registra legacy_mime_mismatch e mantém bytes, associação e hash desconhecido, sem bloquear os arquivos novos válidos.

A importação terminou antes de uma falha do smoke isolado: a allowlist do navegador administrativo bloqueava duas consultas de histórico necessárias ao bootstrap, causando TypeError: Failed to fetch. A correção libera somente essas leituras e mantém RPCs de escrita bloqueadas no navegador de validação. O relatório agora registra importCompleted antes do smoke. Não foi necessário reenviar os arquivos. No Chrome normal autenticado, o painel sincronizou, os 20 thumbnails carregaram e a busca por Suco encontrou 5 itens.

O editor exige escolha explícita de produto quando nenhum bloco estiver selecionado; ao selecionar um bloco, usa seu produto real como alvo visual. Abrir o editor ou importar não grava associação. A aplicação mantém arquivos privados fora do cache PWA e fora do build/Git.

Consulta final de produção confirmou todos os fingerprints da baseline: 687 movimentos; global 184 = unallocated 178 + slots 6; layout e vínculos de produto idênticos. Activation Point permanece no estado anterior. Bucket privado, catálogo 20, objetos 20, caminhos library 19 e hashes novos 19. Owner e manage_fridge_layout gerenciam; attendant comum lê; isolamento entre lojas e restrições de escrita passaram em homologação com dados artificiais. Não foram feitos movimentos fictícios em produção.

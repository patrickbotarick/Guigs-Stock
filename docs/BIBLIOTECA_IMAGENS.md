# Biblioteca de imagens de produtos

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

- 34 controles locais da biblioteca, com PNG/JPEG/WebP artificiais, tamanho, formato inválido, SHA, duplicata, nomes com espaço/acentos/caracteres especiais, aliases, RLS, compartilhamento, desvinculação, arquivamento e isolamento.
- Suíte espacial com a biblioteca: 455 controles. Inclui seleção, associação a segundo produto, remoção preservando objeto, reload e atendente sem escrita no modal.
- API real de homologação valida importação/reexecução, PNG/JPEG/WebP, aliases, conteúdo imutável, reutilização, troca sem upload, owner/delegado/atendente e isolamento, sem movimento de estoque.
- Navegador com Supabase de homologação: 46 controles, três papéis reais artificiais, biblioteca, seleção/remoção de vínculo, thumbnails, PWA v14, offline/reload/reconexão. Mapa e ledger iguais antes/depois.
- Regressão geral: 1.206 controles aprovados. Build por allowlist, 18 arquivos públicos, sem imagens locais. Testes de alvo: 13 controles.

Backup manual conferido: pre-library-2026-11-05_17-14-27-b73cd9fc. Archive 386.027 bytes, SHA-256 3D870059429767E9ACFB606B85A58069192D067CD738D0154957C37B105F65D9. Manifesto, snapshot e hashes conferidos. Dump não contém bytes de Storage; o objeto legado é preservado e os novos originais permanecem na pasta local do responsável.

Baseline de produção: 687 movimentos, ledger 0470bca16323e2652e046bfe200d297c, global 184 = unallocated 178 + slots 6, layout 09b4fe20d734029675c1d856fa5c3250, vínculos de imagem dos produtos ed0f61b1fae260da037713adcea97a7f. Activation Point já estava cruzado, com duas linhas espaciais, e deve permanecer igual.

Aplicar apenas a nova migration exata após os gates, uma vez, com alvo conferido. Hash do SQL 1FA68893B13630E01ECCAF7880BD1BC4EC9FBC208D1DEACE365B0E951C4E82E1. Não executar db push, reset, restore ou migrations antigas. Frontend anterior continua lendo caminhos antigos e novos e enviando caminhos legados; não reverter CHECK/RPC nem apagar catálogo como rollback. Preferir correção aditiva e preservar todas as imagens e vínculos. Nenhuma tag nova é necessária.

Estado provisório BIBLIOTECA DE IMAGENS NO-GO até concluir produção, importação e fingerprints finais.

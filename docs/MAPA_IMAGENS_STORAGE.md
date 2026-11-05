# Storage de imagens do mapa

Contrato atual: [biblioteca reutilizável](BIBLIOTECA_IMAGENS.md) e [validação final de 05/11/2026](VALIDACAO_FINAL_MAPA.md). As seções abaixo registram a correção histórica do Storage. A UI atual desvincula sem apagar arquivos; objetos catalogados são imutáveis, e a troca usa outro vínculo. DELETE exige catálogo inativo e nenhum produto vinculado. Não interpretar o fluxo antigo de remoção automática abaixo como comportamento atual. A auditoria atual encontrou 19 objetos e uma referência de POTY 2L sem objeto, mantendo o aceite integral NO-GO.

## Auditoria de 5 de novembro de 2026

O frontend espera o bucket `guigs-product-images`, definido em `fridges.js` na constante `imageBucket`. `imageExtensions` aceita PNG, JPEG e WebP. O limite existente é 2 MiB (2.097.152 bytes), preservado nesta correção.

A migration histórica `20261104132033_spatial_fridge_product_images.sql` criou o helper de autorização, SELECT/INSERT e a RPC do vínculo. Ela não provisiona o bucket. Essa tarefa ficou somente em `scripts/homologation/fridge-storage.cjs`, protegido para homologação. Em produção, `storage.buckets` estava vazio e SELECT/INSERT eram as únicas policies. O erro Bucket not found decorre dessa lacuna de provisionamento. Não havia outra migration pendente de criação de bucket.

A correção acrescenta `20261105124008_map_image_storage_access.sql`, sem reescrever migrations aplicadas, e provisiona o bucket pela API de Storage através do painel administrativo. A migration não escreve em saldos, movimentos, lotes ou estrutura do mapa.

## Contrato e autorização

| Item | Regra |
|---|---|
| Bucket | guigs-product-images, privado |
| MIME | image/png, image/jpeg, image/webp |
| Tamanho | máximo 2.097.152 bytes por objeto |
| Path | shop_uuid/product_uuid/random_uuid.png, .jpg ou .webp |
| SELECT | membro autenticado e ativo da loja do produto |
| INSERT | owner ou membro ativo com manage_fridge_layout |
| UPDATE | mesma autorização, com USING e WITH CHECK |
| DELETE | mesma autorização, somente depois de desvincular o objeto |
| RPC guigs_set_product_image | mesma autorização de escrita, produto da loja, objeto existente, bloqueio de linha e CAS do vínculo anterior |
| Atendente comum | leitura, sem upload/update/delete ou alteração do vínculo |
| Anônimo / outra loja / vínculo inativo | acesso recusado |

As policies `guigs_product_images_read` e `guigs_product_images_insert` passam pelo helper atualizado. As novas são `guigs_product_images_update` e `guigs_product_images_delete`. O helper valida UUIDs, extensão, produto, shop_id e membership atual. A autorização não vem de user_metadata nem da UI. Grants de RPC continuam restritos a authenticated, com search_path vazio. Não há chave privilegiada no frontend.

A foto pertence ao produto e aparece em todos os blocos associados ao mesmo SKU. O caminho existente é mantido, sem inferir associação de produto ou capacidade de um bloco.

## Fluxos

Upload valida MIME/tamanho no cliente e no bucket, gera caminho novo e envia com upsert false. A RPC associa a foto somente se o caminho anterior ainda for o esperado. Leitura usa URLs assinadas por 300 segundos, limitadas à origem do próprio projeto. Falha ou arquivo ausente conserva o placeholder. O service worker não armazena fotos privadas nem respostas do Supabase.

Substituição usa objeto novo e CAS. Após confirmar o novo vínculo, a UI remove o arquivo antigo. Remoção primeiro desvincula via CAS e depois chama Storage remove. A policy impede apagar um objeto ainda referenciado. Falha na limpeza é informada sem desfazer um vínculo confirmado. Erro ambíguo de transporte durante o RPC pode deixar um arquivo órfão privado, preservado para inspeção administrativa. Não executar limpeza indiscriminada.

A API também suporta upsert no mesmo caminho para escritores autorizados, com INSERT, SELECT e UPDATE verificados. O fluxo normal de UI usa caminhos novos para evitar cache antigo e proteger substituições concorrentes.

## Implantação controlada

1. Executar testes locais com fixtures e API real somente no projeto descartável zthorgwmnigwceobbkoj. Este recebeu as dependências de capacidade pendente e capability antes da nova migration.
2. Administrador gera backup externo privado. Validar manifesto, hash e snapshot único. O arquivo de banco não inclui bytes de Storage.
3. Conferir baseline atual de ledger, saldos, estrutura e Activation Point em produção.
4. Aplicar uma vez a nova migration exata no projeto wddbhtxkbrhsjewuaekv. Não executar db push, reset, reparo de histórico ou migrations antigas.
5. No painel Storage do projeto, criar guigs-product-images com Public desativado, limite 2 MiB e os três MIME exatos. Conferir storage.buckets por SQL somente leitura.
6. Publicar frontend compatível, verificar reload/PWA e smoke de imagem real selecionada pelo responsável na própria interface. Não associar SKU a um bloco por conveniência de teste.
7. Comparar o baseline. Qualquer drift exige reconciliação operacional, sem apagar movimentos.

Compensação preferida é uma nova correção aditiva. Frontend anterior continua podendo ler e gravar como owner. Não apagar o bucket, fotos ou policies como rollback automático. Parar antes de produção se os testes ou o backup falharem.

## Evidências desta rodada

- RLS local em PGlite com dados artificiais, 28 verificações aprovadas.
- Navegador com fixtures e PGlite, 98 verificações aprovadas. Inclui upload delegado, substituição com exclusão do objeto anterior, reload, remoção e revogação.
- API real em homologação, 35 verificações aprovadas. PNG/JPEG/WebP, MIME/tamanho inválidos, leitura owner/attendant, INSERT/UPDATE/DELETE owner/capability, bloqueio de atendente comum, CAS, proteção de imagem vinculada, anonimato, arquivo ausente e isolamento entre lojas aprovados. Fixtures sem movimentos de estoque.
- Backup manual pre-storage-2026-11-05_12-43-52-5b0ca950. Archive 384.990 bytes, SHA-256 565F81AE9D90A3AFB01B36BAB39636DF90600A5E52E54F510B322FA599D1809B. Manifesto e baseline conferidos. Pacote privado externo preservado.
- Produção recebeu a migration exata de SHA-256 8A433C22EF9971578A2134B684DA9A853881102735A8890AFF830DF9173AC875. Bucket privado criado pelo painel/API e confirmado em storage.buckets com 2.097.152 bytes e os três MIME. Quatro policies confirmadas. RPC negada a anon e permitida a authenticated.
- Depois da migration e do bucket, o baseline permaneceu idêntico. 685 movimentos, fingerprint 1ad1f15e9e3de81400c8e358830faa69, 178 unidades não alocadas, soma dos slots 0, movimentos espaciais 0, Activation Point não cruzado. Estrutura 2/7/13, fingerprint a59a8a8cb947771b17adc6004dee03b8 preservado.
- Frontend publicado no SHA 253e228a85a26c82adda9ba18ee0fda8e2dc40ab. Os 17 arquivos públicos foram comparados ao build e conferem. Reload autenticado do owner e editor de fotos confirmados em produção. Shell PWA recarregado offline e reconectado em contexto isolado, sem sessão nem mutações.
- Regressão espacial aprovada em 374 verificações e guard do alvo homolog em 13. Regressão geral aprovada em 1.205 verificações, incluindo segurança, proteção de produção e PWA. Auditoria Git sem achados. Smoke de produção aprovado. O responsável selecionou e salvou pela própria interface uma imagem real de POTY 2L. O Storage confirmou um PNG de 110.586 bytes, um produto vinculado e zero referências quebradas. O navegador confirmou leitura integral em 1.000 × 1.000 pixels, também depois de reload, com estoque sincronizado. A leitura final de ledger, saldos, estrutura e Activation Point ficou exatamente igual ao baseline anterior. Estado final STORAGE DE IMAGENS DO MAPA APROVADO.

Referências oficiais [controle de acesso](https://supabase.com/docs/guides/storage/security/access-control) e [criação e restrições de bucket](https://supabase.com/docs/guides/storage/buckets/creating-buckets).

A nova autorização de fotos foi comprovada na API de homologação com contas artificiais, incluindo delegado e atendente comum. Em produção, o smoke de escrita e leitura foi feito com a sessão owner real existente, sem novos usuários, delegações ou movimentos. Os avisos do advisor de homologação sobre RPCs históricas e configuração de Auth permanecem fora do escopo desta correção. A RPC de imagens foi conferida sem EXECUTE para anon.

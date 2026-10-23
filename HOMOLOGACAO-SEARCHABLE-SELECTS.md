# Seletores pesquisáveis — manutenção de frontend 1.5

Base: `fb81b21a4d6f440d4b1086492305d303ca5007f8` (main).
Branch: `feature/1.5-searchable-selects-ui-fix`.

## Escopo

- Editar produto: `editMinFridge` continua ligado a `min_fridge` (Mínimo na geladeira); `editTargetFridge` continua ligado a `target_fridge` (Meta na geladeira).
- Pesquisa em receber produto/fornecedor, movimentar, venda, perda, ajuste e editar produto. Também em produto no histórico e fornecedor na gestão.
- Componente nativo sem dependências: mantém options, IDs, validação e eventos change dos selects. Filtra texto completo, incluindo código do lote, ignorando caixa e acentos; não reordena opções nem altera FEFO. Os saldos continuam nos rótulos/balanços originais.
- Clique/foco abre a lista; texto filtra; Enter ou clique/toque seleciona; setas navegam; Escape fecha a lista e restaura a seleção; Tab segue ao próximo campo. Digitar sem selecionar não troca o ID. Limpar a pesquisa restaura as opções.
- Combobox/listbox com nomes acessíveis, aria-expanded, aria-controls, aria-activedescendant, aria-selected, aria-required e foco direcionado para campos obrigatórios inválidos.
- Lista com scroll e limite de 30dvh/220px; modal limitado à viewport e rolável; input de 16px para evitar zoom de foco no iOS.
- Cache PWA v6 → v7; estratégia offline preservada.

## Validação automatizada local

Com Node.js, Playwright e Edge disponíveis:

```powershell
# Se Playwright não estiver na resolução padrão:
$env:PLAYWRIGHT_MODULE_PATH = 'CAMINHO_ABSOLUTO_PARA_PLAYWRIGHT'
# Opcional: caminho alternativo ao Edge instalado no local padrão:
$env:BROWSER_EXECUTABLE = 'CAMINHO_ABSOLUTO_DO_NAVEGADOR'
node tests/searchable.cjs
node tests/browser.cjs
git diff --check
```

- `searchable.cjs`: 110 verificações em desktop/mouse e mobile/toque, 80 produtos ativos artificiais, caixa/acentos, lotes, IDs, saldos, fornecedores ativos/inativos, labels, teclado, required, reset, histórico, scroll por gesto de toque e viewport reduzida a 390×420. Bloqueia rede externa e rejeita qualquer RPC de escrita.
- `browser.cjs`: 45 verificações de regressão com cliente Supabase inteiramente simulado: owner/attendant, login, histórico, fornecedores, FEFO, sidebar e PWA/offline. Recebimentos, fornecedores e transferências alteram apenas arrays artificiais do mock.
- Ambos os servidores substituem a configuração e o SDK do Supabase por mocks; não leem nem servem `config.js` real.
- Teste de banco `tests/database.cjs` NÃO executado: contém SQL e migrations, fora do escopo autorizado.
- Capturas desktop/mobile inspecionadas visualmente. Nenhuma conexão ou operação em Supabase real.

## Homologação manual pendente

- Conferir teclado virtual em aparelhos físicos Android/iOS (as viewports reduzidas automatizadas não reproduzem todos os teclados virtuais).
- Conferir anúncios por leitor de tela (NVDA/VoiceOver) e navegação com teclado físico.
- Conferir atualização de uma instalação PWA já existente após futuro merge/deploy autorizado; o teste automatizado instala o cache novo em contexto isolado.
- Usar ambiente isolado com dados artificiais para validar operações completas. Não realizar operações de estoque em produção apenas para testar.

Nenhuma migration, SQL, schema, RLS, RPC, configuração, usuário ou dado real foi modificado. Nenhum merge, tag, release ou deploy faz parte desta entrega.

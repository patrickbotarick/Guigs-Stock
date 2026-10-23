# Checklist antes de release

Responsável / data / SHA / aprovação: registrar em controle privado.

## Git
- [ ] Branch feature correta, main atualizada antes da criação; sem alterações diretas nela.
- [ ] Working tree limpa; diff restrito ao escopo e revisado; testes aprovados.
- [ ] Nenhum push/main, merge, tag, release ou deploy sem autorização correspondente.

## Banco
- [ ] Mudança exige migration? Se não, registrar “não necessária”.
- [ ] Migration nova/aditiva, revisada e testada em isolamento; não reexecutar 001–006/900/901.
- [ ] Frontend anterior e contratos RPC continuam compatíveis; locks e duração avaliados.
- [ ] Backup realizado pelo administrador, externo/privado, hash conferido e restore isolado validado.
- [ ] Dependências Auth/roles/Storage/configuração e ponto recuperável confirmados.
- [ ] Plano de rollback/compensação, janela, responsável e perda aceitável aprovados.

## Segurança
- [ ] `node scripts/audit-repository.cjs` sem candidatos pendentes; revisão de segredos no diff e histórico.
- [ ] `config.js` ignorado/não rastreado; `.env`, credenciais, backups e dumps fora do Git.
- [ ] Nenhuma service_role/sb_secret no frontend; env de preview não aponta para produção em testes.
- [ ] Rulesets/revisão de main, acessos e secret scanning/push protection conferidos pelo administrador.

## Testes
- [ ] Scripts: `pwsh -NoProfile -File tests/production-protection.ps1` e `node tests/security.cjs`.
- [ ] Navegador com mocks: `node tests/browser.cjs` e `node tests/searchable.cjs`.
- [ ] Desktop/mobile, teclado/toque, PWA/offline e atualização de cache revisados conforme a mudança.
- [ ] `git diff --check`; nenhuma escrita/conexão automatizada em Supabase real.

## Publicação e acompanhamento
- [ ] Revisão/merge e eventual migration explicitamente autorizados; equipe avisada.
- [ ] Confirmar projeto/branch Cloudflare, configuração privada e deploy esperado após autorização.
- [ ] Após deploy: smoke test de login/leitura/histórico/permissões; nenhuma escrita fictícia de estoque.
- [ ] Monitorar erros e operação; registrar deployment e ponto de rollback.
- [ ] Se falhar: [EMERGENCIA.md](EMERGENCIA.md); não improvisar SQL.

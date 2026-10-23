# Guig's Stock — proteção de produção

- `main` e Cloudflare Pages main são produção. Trabalhar em feature isolada da main atual e auditar Git antes de editar; não fazer merge, tag ou deploy sem autorização explícita.
- O Supabase atual contém dados reais. Nunca usar esses dados/credenciais para testes, seed, reset, bootstrap ou movimentações fictícias.
- Manutenção não autoriza executar SQL/migrations, alterar RLS/RPCs ou modificar usuários/dados de produção. Uma futura intervenção exige autorização específica e [procedimento de migration](docs/MIGRATIONS_SEGURAS.md).
- Qualquer operação destrutiva ou restore exige aprovação explícita do responsável pelo sistema. Não executar restore automático.
- Seguir [política de produção](docs/PRODUCAO_E_SEGURANCA.md); documentos antigos de piloto não são autorização operacional.
- Testar com mocks e dados artificiais. Nunca imprimir segredos ou ler/servir config.js real nos testes. Não executar scripts antigos de provisionamento como diagnóstico.
- Nunca versionar config.js, .env, credenciais, dumps ou dados reais. Backups somente externos ao Git, privados e sob execução manual do administrador.
- Validar alterações com `node scripts/audit-repository.cjs`, `node tests/security.cjs`, `pwsh -NoProfile -File tests/production-protection.ps1` e testes de navegador apropriados com mocks. Revisar diff e deixar claro qualquer teste não executado.

# Recuperação e rollback

Qualquer operação destrutiva ou restore exige aprovação explícita do responsável pelo sistema.

Não existe restore automático neste repositório. Antes de qualquer intervenção: registrar incidente/horário, responsável, último estado saudável e alvo; interromper novas alterações pelos procedimentos operacionais da equipe; preservar logs privados e cópia do estado atual quando autorizado. Identificar perda aceitável e escritas ocorridas depois do backup. Não alterar RLS nem usuários para contornar o incidente.

## Cenários

| Cenário / sintomas | Primeira ação | Não fazer | Recuperação possível | Backup necessário | Validação posterior |
|---|---|---|---|---|---|
| Frontend quebrado: tela vazia, erro JS após release | Identificar deploy/SHA e último frontend compatível | Não alterar banco nem limpar dados | Rollback do deployment de produção conforme procedimento abaixo | Código/deployment estável; não exige restore de dados | Login, leitura, histórico, permissões, dispositivos com PWA/cache anterior |
| Migration com erro: falha SQL, objeto ausente, RPC incompatível | Parar aplicação de SQL, identificar commit e transação/estado parcial | Não reaplicar todas migrations, executar DOWN ou remover coluna | Se transação não confirmou, conferir rollback; se confirmou, correção aditiva ou recuperação aprovada em janela | Cópia anterior e cópia do estado pós-falha para análise | Catálogos, grants/RLS, contratos de RPC e frontend anterior; ensaio isolado |
| Dado alterado incorretamente: saldo/cadastro divergente | Preservar histórico e identificar operação, lote/loja e autor privadamente | Não editar histórico nem “compensar” sem conferir efeito | Plano pontual aprovado; eventual compensação pelas operações oficiais somente pelo responsável | Backup ajuda a comparar estado anterior; não restaurar banco inteiro por um registro | Conferência de saldos, vínculos e trilha de auditoria pelo operador autorizado |
| Perda parcial: registros/intervalo ausentes | Delimitar escopo e interromper mudanças | Não importar CSV ou dump indiscriminadamente sobre banco vivo | Recuperar backup em ambiente isolado, comparar dependências e aprovar reparo pontual | Cópia anterior íntegra, FKs/Auth e evidências atuais | Sem duplicação, vínculos preservados, histórico e saldos consistentes |
| Perda total do banco: projeto/dados inacessíveis ou removidos | Acionar administrador, verificar backups independentes e estado do serviço | Não recriar schema e improvisar usuários em produção | Preferir recuperação gerenciada Supabase conforme plano; se inviável, reconstruir em projeto isolado com procedimento oficial completo e aprovar cutover | Backup completo com Auth/dependências, configuração privada e Storage se usado; archive da aplicação sozinho é insuficiente | Usuários/identidades, memberships, seis tabelas, funções privadas/RPCs, RLS, índices, contagens/saldos privados e cliente anterior |
| Credencial exposta: alerta de scanning, token em log/Git | Identificar tipo, revogar/rotacionar pelo administrador e preservar evidências sem valor | Não considerar remover arquivo como revogação; não repostar segredo | Atualizar consumidores privados, revisar acessos/logs; eventual saneamento do histórico com plano coordenado | Backup não revoga chave; preservar evidências privadas | Chave antiga rejeitada, consumidores atualizados; nenhuma chave privilegiada no frontend |
| Usuário comprometido: sessão/operação suspeita | Acionar administrador para revogar sessões/bloquear acesso sob autorização | Não apagar auth.users ou histórico | Recuperar conta conforme Auth, revisar memberships/MFA e operações afetadas | Cópia/histórico ajudam na análise; não restaurar todo o banco só pela conta | Sessões suspeitas inválidas, acesso legítimo restabelecido e operações revisadas |
| Cloudflare indisponível: frontend fora do ar | Confirmar incidente oficial e alcance; comunicar equipe | Não mover DNS/backend ou publicar cópia improvisada com credenciais | Aguardar serviço ou ativar contingência de frontend previamente aprovada | Código/deployment e configuração privada; banco não precisa ser restaurado | HTTPS, login, leitura, domínio e PWA; reconciliar registro manual aprovado após retorno |

## Rollback do frontend (manual, não executado nesta fase)

Ponto estável conhecido: tag `v1.5.0` → `17cf2a832d26b7071452ee377d80e4b3f5efba2d`. Essa referência foi conferida localmente; a correspondência com um deployment Cloudflare deve ser verificada no painel pelo responsável.

Comandos somente de leitura para conferir o código:

```powershell
git show --no-patch --format=fuller v1.5.0
git rev-parse 'v1.5.0^{commit}'
git diff --stat v1.5.0..main
```

1. Confirmar compatibilidade do commit com o banco atual e autorização de rollback; registrar deployment atual e alvo. Não usar `git reset --hard`/force push na main.
2. No Cloudflare Pages, abrir projeto → Deployments → localizar deployment **de produção** anterior bem-sucedido → conferir SHA → menu de ações → “Rollback to this deployment” → confirmar somente após autorização. Preview não é alvo válido de rollback.
3. Se o deployment não existir, preparar redeploy do SHA conhecido em procedimento separado, com ambiente/configuração privada revisados e autorização explícita. Não criar tag nesta fase nem supor que uma tag sozinha publica arquivos.
4. Validar login/leitura, histórico, permissões e PWA em desktop/celular. Rollback do frontend não reverte banco ou alterações realizadas pelos usuários. Não testar escrita fictícia contra produção.
5. Considerar service worker: um rollback pode reintroduzir identificador de cache antigo. Conferir atualizações/abas antigas e preparar correção de cache revisada se necessário; não prometer que o painel invalida todo cache local.
6. Abrir correção na feature e reconciliar código da main via revisão autorizada antes da próxima release; próximo deploy automático pode substituir o rollback.

Procedimento baseado em [Cloudflare Pages — rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/), consultado em 23/10/2026. Nada foi acionado no painel/API.

## Restore aprovado: sequência de decisão

1. Conferir origem, data, escopo e hash da cópia, ponto de recuperação e credenciais administrativas fora do Git. Definir janela e interrupção operacional.
2. Ensaiar primeiro em destino privado isolado, com acesso a dados reais formalmente aprovado. Verificar Auth/roles/extensões antes das FKs da aplicação e configurações de serviços; seguir [procedimento oficial Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
3. Conferir estrutura, grants, policies, RPCs/overloads, relações, contagens e saldos em relatório privado, sem divulgar dados. Registrar resultado e perda estimada desde a cópia.
4. Aprovar explicitamente plano de produção, alvo e estratégia de retorno caso o restore falhe. Somente administrador executa manualmente; não há comando de restore pronto para colar neste projeto.
5. Validar restauração/cutover, TLS/configuração e login/leitura, comunicar recuperação e monitorar. Reconciliar operações posteriores ao backup sob aprovação; não inventar movimentações nem apagar histórico.

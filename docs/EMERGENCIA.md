# Emergência — roteiro rápido

Os dados são reais. Qualquer operação destrutiva ou restore exige aprovação explícita do responsável pelo sistema. Contatos e acessos de contingência devem estar em cofre privado disponível ao administrador.

## Frontend quebrou
1. Não alterar banco. Registrar horário, erro e deployment.
2. Identificar último frontend compatível; referência v1.5.0 = `17cf2a832d26b7071452ee377d80e4b3f5efba2d`.
3. Responsável aprova rollback; administrador executa no Pages conforme [RECUPERACAO.md](RECUPERACAO.md).
4. Validar login/leitura, histórico e PWA; monitorar e preparar correção em feature.

## Banco apresentou problema
1. Interromper alterações e orientar equipe a suspender operações afetadas.
2. Não executar SQL aleatório, reset, seed, migrations antigas ou bootstrap.
3. Preservar evidências privadas e identificar operação/migration causadora.
4. Conferir backup, hash, data, dependências e perda aceitável.
5. Validar recuperação isolada; restore somente manual, com plano aprovado.
6. Conferir saldos/histórico privadamente; comunicar retomada.

## Chave vazou
1. Administrador revoga/rotaciona; remoção do Git não basta.
2. Atualizar consumidores e configuração privada conforme tipo de chave.
3. Revisar Git, logs e usos suspeitos sem divulgar valor.
4. Se frontend precisar atualizar, redeploy somente autorizado; nunca colocar chave privilegiada nele.
5. Confirmar chave antiga inválida, revisar sessões e acessos afetados.

## Conta comprometida / provedor fora do ar
1. Acionar administrador, preservar evidências e limitar operação afetada.
2. Conta: revogar sessões/restabelecer acesso sob autorização; não apagar usuário/histórico.
3. Provedor: confirmar incidente oficial, comunicar equipe e seguir contingência aprovada; não migrar backend/DNS de improviso.
4. Seguir cenários e validações em [RECUPERACAO.md](RECUPERACAO.md).

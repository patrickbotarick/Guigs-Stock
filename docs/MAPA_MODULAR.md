# Mapa modular e permissão de layout

O mapa é uma configuração operacional contínua, editável antes e depois da primeira alocação. Coordenadas e dimensões são proporções. Geladeiras, níveis e blocos podem ser reordenados, renomeados e desativados pelo editor. Desativar preserva histórico e permite reativação. Um bloco vazio também pode mudar de nível ou geladeira.

## Estados

- **Configuração pendente** exige completar produto e capacidade. Os dois campos podem ficar em branco. O backend rejeita qualquer entrada de estoque enquanto um deles estiver pendente.
- **Pronto para abastecer** indica produto definido e capacidade positiva em estrutura disponível, ainda sem abastecimento daquele produto.
- **Ativo** indica bloco configurado com saldo ou histórico de abastecimento do produto associado. Quando o saldo zera, continua sujeito ao estado operacional vazio e à reposição.

O estado de ativação do bloco é derivado do ledger. A primeira alocação real em qualquer bloco continua sendo o Activation Point global. Outros blocos podem permanecer pendentes e o restante do estoque permanece não alocado.

## Segurança de edição

Com saldo no bloco, o backend impede desativar, retirar ou trocar produto, retirar capacidade, reduzir capacidade abaixo do saldo e mover para outro nível ou geladeira. Renomear e ajustar proporções permanece permitido. Geladeiras e níveis com saldo em seus blocos também recusam desativação.

Remover do mapa significa desativar. Dividir a organização exige cadastrar blocos adicionais e, se necessário, executar realocação auditável em uma etapa operacional autorizada. O editor não distribui saldo automaticamente.

## Delegação

A coluna booleana manage_fridge_layout pertence ao vínculo da pessoa com a loja e começa falsa. O papel continua owner ou attendant.

Owner sempre edita o layout e pode conceder ou revogar a permissão de um atendente ativo no próprio editor. Atendentes autorizados editam somente estrutura, capacidade e associação de produto. Relatórios restritos, ajuste de saldo, imagens, distribuição de estoque e administração das próprias permissões preservam seus controles existentes.

O backend valida a capability em cada gravação, sob a mesma exclusão usada pela configuração de estoque. RLS e ausência de DML direto continuam protegendo as tabelas. Revogar a permissão bloqueia a próxima gravação, mesmo quando uma tela antiga mantém o editor aberto.

A migration é aditiva. Os vínculos existentes recebem a permissão falsa. Capacidades, produtos, coordenadas, nomes, movimentos e saldos existentes são preservados.
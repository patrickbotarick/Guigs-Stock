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

Owner sempre edita o layout e pode conceder ou revogar a permissão de um atendente ativo no próprio editor. Atendentes autorizados editam estrutura, capacidade, associação de produto e fotos. Relatórios restritos, ajuste de saldo, distribuição de estoque e administração das próprias permissões preservam seus controles existentes. O contrato de fotos e suas policies estão em [Storage de imagens](MAPA_IMAGENS_STORAGE.md).

O backend valida a capability em cada gravação, sob a mesma exclusão usada pela configuração de estoque. RLS e ausência de DML direto continuam protegendo as tabelas. Revogar a permissão bloqueia a próxima gravação, mesmo quando uma tela antiga mantém o editor aberto.

A migration é aditiva. Os vínculos existentes recebem a permissão falsa. Capacidades, produtos, coordenadas, nomes, movimentos e saldos existentes são preservados.

## Release e ativação operacional

A v1.7.0 entrega o mapa modular e pode ser lançada com blocos pendentes e saldo não alocado. Medição, associação de produto e configuração física completa não são pré-requisitos para a release.

A equipe da pizzaria pode completar cada bloco conforme a realidade física. Blocos prontos podem ser usados enquanto os demais permanecem pendentes. Todo saldo ainda sem posição continua não alocado.

O Activation Point é a primeira alocação real de saldo não alocado em qualquer slot físico. Depois desse ponto, um rollback apenas do frontend é insuficiente. A recuperação deve preservar ou reconciliar as partições espaciais e os eventos do ledger.
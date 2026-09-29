<!-- prints: nenhum. Só para o canal da staff, publicado à mão. -->

## Volk: configuração para admins
Comandos para quem tem Gerenciar Servidor ou o cargo de admin do Volk. Funcionam em qualquer canal, e as respostas só você vê.

**Painel**
- `/volk setup channel:#canal`: define o canal do painel. O canal precisa de Ver canais, Enviar mensagens, Inserir links, Anexar arquivos, Ver histórico de mensagens e Gerenciar mensagens; se faltar algo, o comando diz o quê.
- `/volk republish`: apaga e posta o painel de novo, para quando ele travar ou for apagado.
- `/volk config`: mostra a configuração inteira e os servidores do menu.
- `/volk language code:pt`: idioma do painel (de, en, fr, pt, ru, uk, zh).
- `/volk auto active:true interval:60`: atualização automática, de 30 a 3600 segundos.

**Servidores do menu**
- `/volk search name:FEB`: acha o id de um servidor pelo nome.
- `/volk pin id:<id> label:<nome>`: fixa um servidor no menu, mesmo offline ou em seed.
- `/volk unpin id:<id>`: tira o servidor do menu.
- `/volk discovery active:true min-players:50 count:8`: inclui no menu servidores em partida agora. Vale para todos os Discords que usam este bot, não só o nosso.

**Cargos**
- `/volk roles action:list`: mostra quem configura e quem opera.
- `/volk roles action:allow level:operator role:@Cargo`: esse cargo passa a operar o painel. Sem nenhum cargo de operador, qualquer um no canal opera.
- `/volk roles action:allow level:admin role:@Cargo`: esse cargo passa a configurar. Gerenciar Servidor sempre conta como admin.
- `action:remove` desfaz qualquer um dos dois.

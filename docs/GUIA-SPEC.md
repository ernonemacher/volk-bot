# Especificação: guia de uso do Volk para o Discord do clã

29/09/2026

## Objetivo e público

O guia ensina um membro do clã a ler o painel do Volk e a confirmar bandeiras durante a partida, em menos de 5 minutos de leitura. Ele substitui a explicação boca a boca no canal de voz e é o link que se passa para quem pergunta "o que é esse mapa?".

Três leitores, em ordem de prioridade:

| Leitor | Quantos | O que precisa saber | Parte do guia |
| --- | --- | --- | --- |
| Membro | Quase todos | Ler o mapa: cores, números, porcentagens, linha branca | Posts 1 a 3 |
| Operador (SL, quem chama objetivo) | Poucos por partida | Escolher servidor e time, confirmar bandeira, desfazer e recomeçar | Post 4 |
| Admin do Discord | 1 a 3 pessoas | `/volk setup`, cargos, idioma, fixar servidor | Post à parte, fora do canal público |

Critério de sucesso: um membro que nunca viu o painel, depois de ler, sabe dizer qual é a próxima bandeira provável e confirmar a que o time acabou de capturar, sem perguntar a ninguém.

## Formato no Discord

O guia é uma sequência de 5 mensagens curtas num canal só de leitura, cada uma com um assunto e de 1 a 3 prints, mais uma mensagem de índice fixada no topo. Uma mensagem longa com 8 imagens empilhadas perde o leitor no segundo print.

Restrições que moldam o texto:

- **2000 caracteres por mensagem.** Cada post cabe nisso com folga; se não couber, o assunto está grande demais e vira dois posts.
- **Sem tabelas.** O Discord não renderiza tabela em Markdown. As tabelas de [USAGE.md](USAGE.md) viram listas com o termo em negrito.
- **Markdown disponível:** `#`, `##`, `###`, listas, **negrito**, `-#` para nota pequena, links mascarados `[texto](url)` e links para outras mensagens (usados no índice).
- **Até 10 anexos por mensagem, 10 MB cada** em conta sem Nitro. Um print de painel em PNG fica bem abaixo disso.
- **Imagem solta aparece maior que imagem dentro de embed.** O guia usa anexos soltos, pelo mesmo motivo do próprio painel.

Onde publicar: um canal `#guia-volk` (ou um post de fórum) onde só admins escrevem, com o índice fixado. O canal do painel não serve. Colado à mão, o guia empurra o painel para cima e some no histórico. Postado pelo bot é pior: ao iniciar, `adoptMessages` ([bot.js](../src/bot.js)) apaga toda mensagem do bot que não seja o par do painel, e uma mensagem do guia com embed poderia até ser adotada como o texto do painel.

Cada post é escrito aqui no repositório como um arquivo Markdown já no formato do Discord (`docs/guia/01-o-que-e.md` etc.). Esses arquivos são a fonte única das duas formas de publicar (seção seguinte).

## Publicação

Duas formas, a partir dos mesmos arquivos:

- **À mão:** `node src/guide.js <guildId> 01 | pbcopy` copia o post 01 já preenchido para o servidor escolhido; cola na sua conta e anexa os prints que o comando lista no stderr. O índice (`00`) sai com `{{01}}`..`{{05}}`, trocados à mão pelos links das mensagens depois de postar.
- **`/volk guide`:** o bot posta a sequência inteira num canal. Serve para republicar quando o painel mudar e para outros servidores que usam o Volk.

Os arquivos têm dois marcadores, preenchidos por [guide.js](../src/guide.js) com a configuração de cada servidor, para um texto só servir a todos:

- `{{painel}}`: menção ao canal do painel.
- `{{operadores}}`: "só quem tem o cargo @X. Sem ele, ..." com os cargos de operador, ou "qualquer pessoa no canal." quando não há nenhum.

Menção a canal não notifica ninguém. Menção a cargo notifica quando cola à mão, se o cargo for mencionável ou se quem posta tiver permissão de mencionar todos; começar a mensagem com `@silent` evita a notificação. O `/volk guide` manda com `allowedMentions` vazio, que mostra o nome do cargo e não notifica.

Comportamento de `/volk guide` ([commands.js](../src/commands.js)):

- Só admin (mesmo nível de `/volk setup`).
- Opção `channel`, padrão o canal atual, no mesmo padrão dos outros subcomandos. Recusa o canal do painel, pelo motivo acima; o `/volk setup` recusa, pelo mesmo motivo, o canal do guia.
- Verifica antes de postar as permissões View Channel, Send Messages, Attach Files, Read Message History e Pin Messages, e nomeia a que falta, como o `/volk setup` já faz.
- Carrega e valida os arquivos antes de tocar no canal: um post acima de 2000 caracteres falha sem apagar o guia que já existe.
- Posta os posts 01 a 05 em ordem, cada um com seus prints como anexos soltos, e por último o índice com os links das mensagens. Fixa o índice.
- Tudo ou nada: se um envio falha no meio, apaga o que já tinha postado e mantém o guia anterior.
- Só depois que o novo entrou, apaga a versão anterior, esteja no mesmo canal ou em outro, para o servidor nunca ter dois guias. Os ids ficam em `guide: {channelId, messageIds}` na configuração do servidor, pelo `saveGuild`.
- Resposta efêmera ao admin com o link do índice, em inglês como as outras respostas de admin.
- O aviso "Volk fixou uma mensagem" que o Discord cria ao fixar fica no canal; em cada republicação aparece mais um.
- O post de admin não é publicado pelo comando: ele vai à mão para o canal da staff.

Formato de cada arquivo em `docs/guia/`: uma linha de cabeçalho com os prints do post (`<!-- prints: P2-mapa-inicio.jpg, P3-mapa-2-confirmacoes.jpg -->`), depois o texto exatamente como vai para o Discord. Só os arquivos `NN-*.md` entram no comando; `admin.md` fica de fora.

## Estrutura do conteúdo

| Post | Título | Cobre | Prints |
| --- | --- | --- | --- |
| 0 | Índice | Uma linha por post, com link para a mensagem. Fixado. | nenhum |
| 1 | O que é o Volk | Em RAAS e Invasion a lane é sorteada no início; nenhuma fonte pública diz quais bandeiras caíram, então o clã confirma à mão e o bot elimina as rotas impossíveis. Onde fica o painel. | P1 |
| 2 | Lendo o mapa | Número dentro do círculo = profundidade a partir do seu main. Cores: verde cheio confirmada, vermelho cheio candidata à próxima, anel colorido possível mais adiante, sumiu = descartada. Porcentagem = chance naquela profundidade. Ponto duplo `2·3`. Linha branca só entre bandeiras vizinhas confirmadas. Seu main, onde a contagem começa, e as zonas tracejadas quando a layer tem. Borda escura fora da área jogável. Keypads de 300 m. | P2, P3, P10 |
| 3 | Lendo o texto do painel | Os campos como aparecem em português: Times, Jogadores, Tempo de partida, A seguir, Rotas restantes, Lane, Bandeira N. | P4 |
| 4 | Operando o painel | Servidor (estrela = fixado). Seu time: só em RAAS/RVAAS e só antes da primeira confirmação. Menu Bandeira N: candidatas mais prováveis primeiro, com keypad e %. Confirmação automática quando só sobra uma candidata. Botões Atualizar, Desfazer, Recomeçar, Abrir no SquadCalc. Troca de layer zera as bandeiras sozinha. | P5, P6, P7 |
| 5 | Quando algo parece errado | Painel pausado (servidor offline ou em seed). Clique recusado durante atualização. Duas bandeiras com o mesmo nome: o keypad desempata. Painel sumiu: volta sozinho, senão um admin roda `/volk republish`. Limite: o bot não sabe tickets nem capturas. | P8, P9 |
| Admin | Configurando o Volk (canal da staff, só à mão) | `/volk setup` e permissões do canal, `republish`, `config`, `language`, `auto`, `search`, `pin`/`unpin`, `discovery` (global), `roles`. Sem convite: o bot já está no servidor. | nenhum ou P11 |

A fonte de verdade do conteúdo é [USAGE.md](USAGE.md). Onde o guia e o painel divergirem, vale o texto que o painel mostra hoje em [locales/pt.json](../locales/pt.json).

## Lista de prints

Dois tipos de captura, com produção diferente:

- **Mapa** (P2, P3, P10): gerado localmente com [render-map.js](../src/render-map.js), sem Discord. É reproduzível: dá para refazer quando o visual mudar.
- **Interface do Discord** (P1, P4 a P9, P11): captura manual da janela do Discord num servidor de teste só seu, com o bot instalado e o `/volk setup` feito, para não expor nomes e avatares de membros. O servidor de teste fixa com `/volk pin` o mesmo servidor de Squad que o clã acompanha.

Layer dos exemplos: **a que estiver ativa no servidor na hora da captura.** O painel segue a layer ao vivo e não dá para forçar uma, então a layer é escolhida pela captura, e não o contrário. Os renders de mapa vêm depois, com a mesma layer e as mesmas confirmações dos prints do Discord.

Requisitos para a layer servir:

- **RAAS ou RVAAS.** O menu Seu time (P5) só existe nesses modos. AAS, Invasion ou Skirmish não mostram a parte mais importante do guia.
- **Alguma bandeira com 3 ou mais candidatas** nas duas primeiras confirmações, para o menu de P6 ter o que mostrar. Se só houver 2, o print vale mesmo assim.

Antes de confirmar qualquer bandeira no Discord, rode `node src/render-map.js <Layer>` e depois `node src/render-map.js <Layer> <B1>`: a linha `next step` mostra quantas candidatas cada escolha deixa, e isso define quais duas bandeiras confirmar. Exemplo testado em 29/09 com Narva_RAAS_v1: A1 → B2 deixa 3 candidatas para a bandeira 3, C1 deixa só 2 para a bandeira 2.

| ID | Mostra | Estado necessário | Como produzir |
| --- | --- | --- | --- |
| P1 | Painel inteiro: texto em cima, mapa embaixo | Layer ativa, 2 bandeiras confirmadas | Captura do canal do painel no servidor de teste |
| P2 | Mapa no início da partida | Mesma layer, nenhuma confirmação | `node src/render-map.js <Layer>` |
| P3 | O mesmo mapa depois de 2 confirmações | Mesmas 2 bandeiras de P1 | `node src/render-map.js <Layer> <B1> <B2>` |
| P10 | Mapa anotado (legenda) | P3 com marcações numeradas: verde cheio, vermelho cheio, anel, linha branca, seu main, keypad | `node tools/annotate-map.mjs <Layer> <B1> <B2> --out=docs/guia/prints/P10-mapa-anotado.jpg` |
| P4 | Só o texto do painel | Igual a P1 | Recorte de P1 |
| P5 | Menu Seu time aberto | Antes da primeira confirmação | Captura com o menu aberto |
| P6 | Menu da próxima bandeira aberto | A bandeira com odds mais variadas, com keypad e % | Captura com o menu aberto |
| P7 | Linha de botões com Desfazer e Recomeçar | Pelo menos 1 bandeira confirmada | Recorte |
| P8 | Painel pausado | Servidor offline ou em seed | Selecionar um servidor fixado que esteja vazio |
| P9 | Aviso "Já estou atualizando" | Clique durante uma atualização | Escolher uma bandeira e clicar em Atualizar menos de 1 s depois |
| P11 | Resposta de `/volk config` | Opcional, só para o post de admin | Captura da resposta |

P2 e P3 são o par mais importante do guia: lado a lado, mostram o mapa encolhendo, que é a ideia inteira do bot. O ponto com duas profundidades (como `4·5`) costuma aparecer só no mapa sem confirmações, então a explicação dele aponta para P2.

Ordem de captura, tudo na mesma partida: P5 primeiro (some na primeira confirmação), depois as 2 confirmações, P1, P4, P6 e P7, e por fim os renders P2 e P3 no computador. O texto dos posts 2 a 4 cita as bandeiras dos prints, então ele é escrito depois da captura.

Regras para todos os prints:

- Interface do Discord em PNG, mapas em JPEG (o render já sai em JPEG; em PNG passaria de 4 MB sem ganhar nitidez). Tema escuro, sem outras abas ou canais sensíveis visíveis.
- Janela do Chrome na tela Retina (DPR 2). No monitor externo (DPR 1) o recorte sai com metade da resolução.
- Mouse fora da mensagem na hora do recorte: o Discord destaca a mensagem sob o cursor.
- Recortar só a área que o post explica; o painel inteiro aparece uma vez só (P1).
- Arquivos em `docs/guia/prints/`, com o ID no nome (`P3-mapa-2-confirmacoes.jpg`).
- Mesma layer em P1 a P10, para o leitor reconhecer o mapa de um print para o outro.
- Tudo entra no git: `docs/guia/*.md`, `docs/guia/prints/` e esta spec. O `/volk guia` lê esses arquivos no host, então eles viajam com o bot. Renders avulsos e testes ficam em `.screenshots/`, gitignorada.

### Script do mapa anotado (P10)

[annotate-map.mjs](../tools/annotate-map.mjs) recebe os mesmos argumentos de `render-map.js` (mais `--out=`), renderiza o mapa com `renderLayer` e desenha por cima, em SVG, um quadrado branco numerado ao lado de cada elemento que o post 2 explica, com uma linha preta até ele. A legenda dos números fica no texto do post, não na imagem, para a imagem não precisar de tradução.

Marcações, na ordem em que o post 2 as explica:

1. A primeira bandeira confirmada (verde cheio)
2. A candidata mais provável à próxima (vermelho cheio)
3. Um anel colorido na posição seguinte
4. O meio da linha branca entre duas confirmadas vizinhas (ou entre o main e a primeira)
5. O seu main
6. A letra do keypad na moldura, acima da coluna da candidata

Decisões de desenho, todas vindas do primeiro render:

- **Quadrado, não círculo:** toda bandeira do mapa é um círculo numerado, e um "1" redondo ao lado da bandeira "1" confundia.
- **Linha preta, não branca:** uma linha de chamada branca se lê como a linha da lane.
- **Número do keypad abaixo da letra:** ao lado dela, "D 6" parece um keypad.
- **Marcação 5 aponta o main, não a zona de proteção:** Narva guarda a zona como Box, e o `mainMarker` de `render-map.js` só desenha Sphere, então nessa layer não há círculo tracejado para apontar.
- **Numeração fixa:** se a layer não tiver um dos elementos, aquele número é pulado, nunca reatribuído, e o script avisa qual faltou.

As posições vêm do próprio código: `laneState` diz quais pontos estão em cada estado e `makeProjector` converte para pixel, somando a moldura (`MARGIN`, 58 px, exportado de `render-map.js` junto com `gridStep`). Cada quadrado vai para a posição mais longe de marcadores, rótulos e outros quadrados, num anel de candidatos em volta do alvo.

### Captura de 29/09

Feita no servidor de teste com FEB #2 em Narva_RAAS_v1, Time 1 (WPMC), lane Abandoned Airfield → Shanty Marina. Todos os prints existem, menos P11 (opcional).

| ID | Arquivo | Observação |
| --- | --- | --- |
| P1 | `P1-painel-inteiro.png` | Duas capturas emendadas: o painel não cabe na altura da janela |
| P2 | `P2-mapa-inicio.jpg` | Render local com as facções da partida |
| P3 | `P3-mapa-2-confirmacoes.jpg` | Render local, mesma lane de P1 |
| P4 | `P4-texto-do-painel.png` | |
| P5 | `P5-menu-seu-time.png` | |
| P6 | `P6-menu-bandeira.png` | Bandeira 2 (Church 50%, Radio Station 25%, Shanty Marina 25%): mais didático que a Bandeira 3, onde as três ficam em 33% |
| P7 | `P7-botoes.png` | |
| P8 | `P8-painel-pausado.png` | FEB #1 offline |
| P10 | `P10-mapa-anotado.jpg` | `node tools/annotate-map.mjs Narva_RAAS_v1 A1 B2 --team1=WPMC --team2=PLAAGF --out=...` |
| P9 | `P9-aviso-atualizando.png` | Só aparece com um clique em outro controle durante um render que gera imagem nova. Um mesmo botão clicado duas vezes não dispara: o Discord bloqueia o segundo clique |

O que a captura mostrou e muda o texto do guia:

- **O mapa aparece pequeno no Discord.** O Discord serve o anexo com 640 px (o original tem 1716) e o mostra com cerca de 350 px numa janela de notebook, onde nomes e porcentagens ficam ilegíveis. O post 2 precisa dizer para clicar no mapa e abrir em tamanho cheio, e explicar a legenda com P3, não com P1.
- **O Discord dos prints está em inglês** ("Today at", "(edited)", "Only you can see this"). Quem usa o Discord em português vê esses textos traduzidos; o guia não cita nenhum deles.
- **O menu mostra keypad, não o código da bandeira.** Shanty Marina aparece como `D5`, enquanto o render e o código a chamam de `B2`. O guia só usa nome e keypad.

## Tom, idioma e vocabulário

- Português do Brasil, segunda pessoa ("você confirma"), frases curtas.
- Vocabulário que o clã já usa em jogo: bandeira, lane, main, SL, keypad, seed. Sem termos do código: nada de "cluster", "solver" ou "profundidade". A posição na lane é explicada como "o número dentro da bandeira"; "Rotas restantes" aparece porque é o rótulo do painel, explicado como traçados possíveis.
- Nomes de botões e menus escritos exatamente como o painel mostra em português: Bandeira N (e não "Objetivo N", como está no USAGE.md em inglês), Seu time, Atualizar, Desfazer, Recomeçar, Abrir no SquadCalc.
- Nenhum travessão longo no texto.
- Cada post abre dizendo o que o leitor vai conseguir fazer, não o que o post contém.

## Fora de escopo e decisões

Fora de escopo: hospedagem e deploy, `/volk stats` e telemetria, o painel de controle do Mac, versões do guia em outros idiomas.

Decisões tomadas em 29/09:

- Layer dos exemplos: a que estiver ativa na hora da captura.
- Publicação: à mão e pelo `/volk guia`, a partir dos mesmos arquivos.
- Git: tudo entra, inclusive os prints.
- Capturas do Discord: servidor de teste.
- Mapa anotado: script SVG sobre o render.
- Post de admin: canal da staff, publicado à mão.
- Acentos de `warn.notAllowed` e `warn.noPanel` em [locales/pt.json](../locales/pt.json) corrigidos antes das capturas.

Perguntas em aberto: nenhuma. O post 4 cita o cargo de operador pelo marcador `{{operadores}}` (decidido em 29/09).

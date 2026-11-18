# Game Shuffle — Banco de dados de jogos + API

O site continua com a **mesma estrutura** (Início, Perfil, filtros, botão de sortear, cards e janela do jogo).
Esta melhoria adiciona:

- **179 jogos** (antes eram 24): PC (Steam/Epic), PlayStation, Xbox, Nintendo, Mobile e **Arcade/Fliperama**.
- **Capas reais** nos cards da página inicial e na janela do jogo.
- **Banco de dados gratuito** (`db/games-db.js`), que funciona sem servidor.
- **API JavaScript** (`db/game-api.js`) para buscar, importar e **exportar capas e informações**.
- **Sorteio pelos gostos do usuário**: jogos parecidos com os favoritos têm mais chance de sair, e os sorteados há pouco tempo têm menos chance de repetir.

## Estrutura

```
game shuffle site/
├── Game Shuffle - Protótipo.html   ← abra este arquivo (layout igual ao de antes)
├── README.md
└── db/
    ├── games-db.js   ← banco de dados (catálogo de jogos)
    └── game-api.js   ← API (capas, sinopses, pesquisa, importação, exportação)
```

> A pasta `db/` precisa ficar **ao lado** do HTML.

## De onde vêm as capas (tudo gratuito, sem cadastro)

| Plataforma | Fonte da capa | Fonte das informações |
|---|---|---|
| PC — Steam | CDN da Steam (capa vertical 600×900, pelo AppID) | Catálogo / CheapShark |
| PC — Epic Games | CheapShark (loja 25 = Epic) + Steam/Wikipédia | Catálogo / CheapShark |
| Consoles (PS, Xbox, Nintendo) | Wikipédia (capa da caixa) | Catálogo / Wikipédia PT |
| Mobile | Wikipédia | Catálogo / Wikipédia PT |
| Arcade / Fliperama | Wikipédia (flyer original do fliperama) | Catálogo / Wikipédia PT |
| Qualquer um (opcional) | RAWG (precisa de chave gratuita) | RAWG |

Ordem que o site tenta: **capa da Steam → capa da Wikipédia → capa gerada** (a capa colorida com as iniciais, como antes).
As capas da Wikipédia ficam guardadas no navegador por 14 dias, então só a primeira visita faz requisições.

## Usando a API

Abra o site, aperte **F12** e vá na aba **Console**:

```js
// Banco local
GameAPI.jogos()                                    // todos os jogos
GameAPI.buscarLocal({plataforma:"Arcade"})         // filtrar (plataforma, genero, loja, texto)
GameAPI.sortear({plataforma:"PC", genero:"RPG"})   // sortear um jogo

// Pesquisar em fontes externas: "steam" | "epic" | "wiki" | "rawg" | "todas"
const r = await GameAPI.pesquisar("Metal Slug 3", {fonte:"wiki"})
const s = await GameAPI.pesquisar("Hades", {fonte:"steam"})

// Importar para o banco (aparece no site na hora e fica salvo no navegador)
await GameAPI.importar(r[0], {p:["Arcade"], g:["Ação"]})

// Adicionar manualmente
GameAPI.adicionar({n:"Meu Jogo", y:2024, s:4, p:["PC"], g:["Indie"], steam:123456, t:"Sinopse..."})
GameAPI.remover(10001)

// Capas e informações
GameAPI.capa(GameAPI.jogo(1))          // URL da melhor capa
await GameAPI.info(GameAPI.jogo(6))    // sinopse + link da Wikipédia (em português quando existe)

// EXPORTAR capas + informações de todos os jogos
GameAPI.exportar("json")               // baixa game-shuffle-AAAA-MM-DD.json
GameAPI.exportar("csv")                // baixa .csv (abre no Excel)

// RAWG (opcional): crie a chave grátis em https://rawg.io/apidocs
GameAPI.configurar({rawgKey:"SUA_CHAVE"})
```

## Adicionando jogos de forma permanente

Edite `db/games-db.js` e adicione uma linha **no final** da lista `games`:

```js
{n:"Nome", y:2024, s:4, p:["PC","PS5"], g:["Ação"], steam:123456, epic:true, w:"Titulo_na_Wikipedia_em_ingles", t:"Sinopse."},
```

- `steam`: número que aparece na URL da loja (`store.steampowered.com/app/`**`123456`**).
- `w`: final da URL da Wikipédia em inglês (`en.wikipedia.org/wiki/`**`Pac-Man`**). Use isso para consoles, mobile e arcade.
- Plataformas aceitas: `PS5`, `Xbox`, `PC`, `Nintendo`, `Mobile`, `Arcade`.

## Observações

- **Capas não aparecem?** Abra o console (F12) e rode `await GameAPI.diagnostico()`. Ele mostra se o banco carregou e se a Steam e a Wikipédia estão acessíveis na sua rede. Se uma fonte estiver bloqueada (comum em redes de escola/trabalho ou com bloqueador de anúncios), o site pula para a próxima automaticamente. Para começar do zero: `GameAPI.limparCache()` e recarregue a página.
- O site precisa de **internet** para mostrar as capas e deve ser aberto em um **navegador** (Chrome, Edge, Firefox). Pré-visualizações dentro de editores de código costumam bloquear imagens externas.
- Jogos importados e o cache de capas ficam no `localStorage` do navegador (cada navegador tem o seu).
- Fortnite, Free Fire e Mobile Legends não têm capa na Wikipédia, então mostram a capa gerada.
- As capas são de propriedade de suas respectivas empresas; o site só mostra os links públicos da Steam/Wikipédia.

/* =====================================================================
   Game Shuffle — API de jogos (GameAPI)
   ---------------------------------------------------------------------
   Roda 100% no navegador, sem servidor e sem chave obrigatória.
   Funciona abrindo o HTML direto (file://) ou hospedado em qualquer lugar.

   Fontes gratuitas usadas:
     • Steam CDN ........ capas verticais 600x900 (via AppID)
     • CheapShark API ... busca de jogos da Steam e da Epic Games Store
     • Wikipédia API .... capas/box art e sinopses de consoles, mobile e
                          fliperamas (arcade) — também é o fallback geral
     • RAWG API ......... (opcional) base com +500 mil jogos; precisa de
                          chave grátis em https://rawg.io/apidocs

   Banco de dados:
     • Catálogo fixo .... db/games-db.js
     • Jogos do usuário . localStorage (importados/adicionados pela API)
     • Cache de capas ... localStorage (evita repetir requisições)

   Uso rápido (console do navegador — F12):
     GameAPI.jogos()                          // lista tudo
     GameAPI.sortear({plataforma:"PC"})       // sorteia um jogo
     await GameAPI.pesquisar("hades")         // busca em Steam/Epic/Wikipédia
     await GameAPI.importar(resultados[0])    // salva no banco e mostra no site
     GameAPI.exportar("json")                 // baixa capas + informações
     GameAPI.exportar("csv")
   Documentação completa: README.md
   ===================================================================== */
(function () {
  "use strict";

  const DB = window.GAME_DB || { platforms: [], genres: [], games: [] };
  const LS_USER = "gs.userGames.v1";
  const LS_CACHE = "gs.coverCache.v1";
  const LS_CONF = "gs.apiConfig.v1";
  const CACHE_OK_TTL = 1000 * 60 * 60 * 24 * 14; // 14 dias
  const CACHE_MISS_TTL = 1000 * 60 * 60 * 24 * 3; // 3 dias
  const USER_ID_BASE = 10000;
  const WIKI_BATCH = 50;

  /* ---------------- utilidades ---------------- */
  const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* armazenamento cheio/bloqueado */ } };
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const wikiKey = (t) => String(t || "").replace(/ /g, "_");
  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status + " em " + url);
    return r.json();
  }

  let config = Object.assign({ rawgKey: "" }, readLS(LS_CONF, {}));
  let cache = readLS(LS_CACHE, {});   // { "Wiki_Title": { u:"url"|"" , t:timestamp } }
  const badUrls = new Set();          // URLs que falharam nesta sessão
  /* Saúde das fontes de imagem nesta rede: null = testando, true = ok, false = bloqueada/lenta.
     Algumas redes (escola, trabalho, provedores, bloqueadores) bloqueiam a Steam em silêncio:
     a imagem fica "carregando" para sempre. Por isso testamos antes e pulamos a fonte bloqueada. */
  const fonteOk = { steam: null, wiki: null };
  const IMG_TIMEOUT = 6000;
  function testarImagem(url, ms) {
    return new Promise((res) => {
      const im = new Image();
      const t = setTimeout(() => { im.src = ""; res(false); }, ms || IMG_TIMEOUT);
      im.onload = () => { clearTimeout(t); res(im.naturalWidth > 0); };
      im.onerror = () => { clearTimeout(t); res(false); };
      im.referrerPolicy = "no-referrer";
      im.src = url;
    });
  }

  /* ---------------- banco de dados ---------------- */
  function decorate(g) {
    const lojas = [];
    if (g.steam) lojas.push("Steam");
    if (g.epic) lojas.push("Epic Games");
    return Object.assign({}, g, { p: g.p || [], g: g.g || [], lojas, s: g.s || 3, y: g.y || "—", t: g.t || "" });
  }
  let catalog = [];
  let userGames = [];
  function rebuild() {
    catalog = DB.games.map((x, i) => decorate(Object.assign({}, x, { id: i + 1 })));
    userGames = (readLS(LS_USER, []) || []).map(decorate);
  }
  rebuild();

  function jogos() { return catalog.concat(userGames); }
  function jogo(id) { id = Number(id); return jogos().find((g) => g.id === id) || null; }

  function buscarLocal(f) {
    f = f || {};
    const q = norm(f.texto);
    return jogos().filter((g) =>
      (!f.plataforma || f.plataforma === "Todas" || g.p.includes(f.plataforma)) &&
      (!f.genero || f.genero === "Todos" || g.g.includes(f.genero)) &&
      (!f.loja || g.lojas.includes(f.loja)) &&
      (!q || norm(g.n).includes(q)));
  }

  /* Sorteio ponderado pelos gostos do usuário:
     jogos com gêneros/plataformas parecidos com os favoritos ganham mais chance,
     e jogos sorteados recentemente perdem chance (evita repetição). */
  function sortear(o) {
    o = o || {};
    const lista = Array.isArray(o.lista) ? o.lista : buscarLocal(o);
    if (!lista.length) return null;
    const favIds = new Set((o.favoritos || []).map(Number));
    const evitar = (o.evitar || []).map(Number);
    const favs = jogos().filter((g) => favIds.has(g.id));
    const gw = {}, pw = {};
    favs.forEach((f) => { f.g.forEach((x) => gw[x] = (gw[x] || 0) + 1); f.p.forEach((x) => pw[x] = (pw[x] || 0) + 1); });
    const n = favs.length || 1;
    const pool = lista.length > 1 && o.atual != null ? lista.filter((g) => g.id !== Number(o.atual)) : lista;
    const weights = pool.map((g) => {
      let w = 1;
      if (favs.length) {
        w += 3 * g.g.reduce((a, x) => a + (gw[x] || 0), 0) / n;
        w += 0.5 * g.p.reduce((a, x) => a + (pw[x] || 0), 0) / n;
        if (favIds.has(g.id)) w *= 0.6; // favorito já é conhecido: chance um pouco menor
      }
      const r = evitar.lastIndexOf(g.id);
      if (r !== -1 && pool.length > evitar.length) w *= 0.15;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let x = Math.random() * total;
    for (let i = 0; i < pool.length; i++) { x -= weights[i]; if (x <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  function nextUserId() { return USER_ID_BASE + userGames.reduce((m, g) => Math.max(m, g.id - USER_ID_BASE), 0) + 1; }
  function persistUser() {
    writeLS(LS_USER, userGames.map((g) => { const c = Object.assign({}, g); delete c.lojas; return c; }));
    emit("gamedb:change", { total: jogos().length });
  }

  function adicionar(dados) {
    if (!dados || !dados.n) throw new Error("Informe ao menos o nome do jogo (campo n).");
    const dup = jogos().find((g) => norm(g.n) === norm(dados.n) || (dados.steam && g.steam === Number(dados.steam)));
    if (dup) return dup;
    const g = decorate({
      id: nextUserId(), n: String(dados.n), y: dados.y ? Number(dados.y) : undefined, s: Math.min(5, Math.max(1, Number(dados.s) || 3)),
      p: (dados.p || []).filter((x) => DB.platforms.includes(x)), g: (dados.g || []).filter((x) => DB.genres.includes(x)),
      t: dados.t || "", steam: dados.steam ? Number(dados.steam) : undefined, epic: !!dados.epic,
      w: dados.w ? wikiKey(dados.w) : undefined, img: dados.img || undefined, fonte: dados.fonte || "manual"
    });
    userGames.push(g);
    persistUser();
    if (g.w && !cache[g.w]) carregarCapas([g]);
    return g;
  }
  function remover(id) {
    id = Number(id);
    const before = userGames.length;
    userGames = userGames.filter((g) => g.id !== id);
    if (userGames.length !== before) persistUser();
    return userGames.length !== before;
  }

  /* ---------------- capas ---------------- */
  const steamCover = (id) => [
    "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + id + "/library_600x900.jpg",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/" + id + "/library_600x900.jpg"
  ];
  const steamHeader = (id) => "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + id + "/header.jpg";

  function cachedWiki(w) {
    const c = w && cache[wikiKey(w)];
    if (!c) return undefined;
    const ttl = c.u ? CACHE_OK_TTL : CACHE_MISS_TTL;
    if (Date.now() - c.t > ttl) return undefined;
    return c.u;
  }

  /** Lista ordenada de URLs de capa para um jogo (melhor → pior). */
  function capas(g) {
    if (!g) return [];
    const out = [];
    const steamOk = fonteOk.steam !== false;
    if (g.img) out.push(g.img);
    if (g.steam && steamOk) out.push(...steamCover(g.steam));
    const w = fonteOk.wiki !== false ? cachedWiki(g.w) : undefined;
    if (w) out.push(w);
    if (g.steam && steamOk) out.push(steamHeader(g.steam));
    return out.filter((u, i) => u && out.indexOf(u) === i && !badUrls.has(u));
  }
  function capa(g) { return capas(g)[0] || null; }
  function marcarFalha(url) { if (url) badUrls.add(url); }

  async function wikiImages(titles, lang) {
    const found = {};
    for (let i = 0; i < titles.length; i += WIKI_BATCH) {
      const chunk = titles.slice(i, i + WIKI_BATCH);
      const url = "https://" + lang + ".wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1" +
        "&prop=pageimages&piprop=thumbnail&pithumbsize=600&pilicense=any&origin=*&titles=" +
        encodeURIComponent(chunk.map((t) => t.replace(/_/g, " ")).join("|"));
      const data = await getJSON(url);
      const q = data.query || {};
      const back = {};
      (q.normalized || []).forEach((n) => back[n.to] = n.from);
      (q.redirects || []).forEach((r) => back[r.to] = back[r.from] || r.from);
      (q.pages || []).forEach((p) => {
        const orig = wikiKey(back[p.title] || p.title);
        if (p.thumbnail && p.thumbnail.source) found[orig] = p.thumbnail.source;
      });
    }
    return found;
  }

  /** Busca (em lote) as capas da Wikipédia que ainda não estão no cache.
      Retorna o número de capas novas encontradas. */
  let loading = null;
  function carregarCapas(lista) {
    const run = async () => {
      const pend = [...new Set((lista || jogos()).filter((g) => g.w && cachedWiki(g.w) === undefined).map((g) => wikiKey(g.w)))];
      if (!pend.length) return 0;
      let found = {};
      try { found = await wikiImages(pend, "en"); } catch (e) { console.warn("[GameAPI] Wikipédia (en) indisponível:", e.message); return 0; }
      const miss = pend.filter((t) => !found[t]);
      if (miss.length) { try { Object.assign(found, await wikiImages(miss, "pt")); } catch (e) { /* sem fallback */ } }
      const now = Date.now();
      let novas = 0;
      pend.forEach((t) => { cache[t] = { u: found[t] || "", t: now }; if (found[t]) novas++; });
      writeLS(LS_CACHE, cache);
      if (novas) emit("gamedb:covers", { novas });
      return novas;
    };
    loading = (loading || Promise.resolve()).then(run, run);
    return loading;
  }
  function limparCache() { cache = {}; badUrls.clear(); writeLS(LS_CACHE, cache); }

  /** Testa se a Steam e a Wikipédia estão acessíveis nesta rede/navegador.
      A fonte que falhar é pulada, e o site usa a próxima (ou a capa gerada). */
  let testando = null;
  function testarFontes() {
    if (testando) return testando;
    testando = (async () => {
      const [s1, w1] = await Promise.all([
        testarImagem(steamCover(292030)[0]),
        testarImagem("https://upload.wikimedia.org/wikipedia/en/1/16/Pac_flyer.png")
      ]);
      fonteOk.steam = s1 || await testarImagem(steamCover(292030)[1]);
      fonteOk.wiki = w1;
      if (!fonteOk.steam) console.warn("[GameAPI] Capas da Steam bloqueadas ou lentas nesta rede — usando Wikipédia.");
      if (!fonteOk.wiki) console.warn("[GameAPI] Imagens da Wikipédia bloqueadas ou lentas nesta rede.");
      emit("gamedb:fontes", Object.assign({}, fonteOk));
      return Object.assign({}, fonteOk);
    })();
    return testando;
  }

  /** Diagnóstico completo (rode no console: await GameAPI.diagnostico()). */
  async function diagnostico() {
    const r = {
      "Banco carregado (db/games-db.js)": !!window.GAME_DB,
      "Jogos no banco": jogos().length,
      "Navegador online": navigator.onLine,
      "localStorage disponível": (() => { try { localStorage.setItem("gs.t", "1"); localStorage.removeItem("gs.t"); return true; } catch (e) { return false; } })(),
      "Capas da Wikipédia em cache": Object.values(cache).filter((c) => c.u).length
    };
    testando = null;
    const f = await testarFontes();
    r["Imagens da Steam acessíveis"] = f.steam;
    r["Imagens da Wikipédia acessíveis"] = f.wiki;
    try {
      await getJSON("https://en.wikipedia.org/w/api.php?action=query&format=json&meta=siteinfo&origin=*");
      r["API da Wikipédia acessível"] = true;
    } catch (e) { r["API da Wikipédia acessível"] = false; }
    r["Jogos com capa disponível"] = jogos().filter((g) => capa(g)).length;
    console.table(r);
    return r;
  }

  /* ---------------- informações (sinopse) ---------------- */
  async function info(g) {
    if (typeof g !== "object") g = jogo(g);
    if (!g) throw new Error("Jogo não encontrado");
    let title = g.w, ptTitle = null;
    try {
      if (!title) {
        const s = await getJSON("https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&list=search&srlimit=1&origin=*&srsearch=" + encodeURIComponent(g.n + " video game"));
        title = s.query && s.query.search[0] && wikiKey(s.query.search[0].title);
      }
      if (title) {
        const ll = await getJSON("https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=langlinks&lllang=pt&origin=*&titles=" + encodeURIComponent(title.replace(/_/g, " ")));
        const pg = ll.query && ll.query.pages && ll.query.pages[0];
        ptTitle = pg && pg.langlinks && pg.langlinks[0] && pg.langlinks[0].title;
      }
      const lang = ptTitle ? "pt" : "en";
      const t = ptTitle || title;
      if (!t) return { sinopse: g.t || "", imagem: capa(g), link: null };
      const sum = await getJSON("https://" + lang + ".wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(wikiKey(t)));
      return {
        sinopse: g.t || sum.extract || "",
        resumoWikipedia: sum.extract || "",
        imagem: capa(g) || (sum.originalimage && sum.originalimage.source) || null,
        link: sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page,
        idioma: lang
      };
    } catch (e) {
      console.warn("[GameAPI] info():", e.message);
      return { sinopse: g.t || "", imagem: capa(g), link: null };
    }
  }

  /* ---------------- pesquisa em fontes externas ---------------- */
  const RAWG_PLAT = [[/^pc$|linux|mac/i, "PC"], [/playstation/i, "PS5"], [/xbox/i, "Xbox"], [/nintendo|wii|switch|game ?boy|nes|snes/i, "Nintendo"], [/ios|android/i, "Mobile"], [/arcade|neo ?geo/i, "Arcade"]];
  const RAWG_GEN = { action: "Ação", adventure: "Aventura", "role-playing-games-rpg": "RPG", shooter: "FPS", sports: "Esportes", racing: "Corrida", strategy: "Estratégia", puzzle: "Puzzle", platformer: "Plataforma", simulation: "Simulação", fighting: "Luta", indie: "Indie" };

  const fontes = {
    async steam(q) {
      const d = await getJSON("https://www.cheapshark.com/api/1.0/games?limit=10&title=" + encodeURIComponent(q));
      return d.filter((x) => x.steamAppID).map((x) => ({
        fonte: "Steam", nome: x.external, steam: Number(x.steamAppID), p: ["PC"],
        capa: steamCover(x.steamAppID)[0], miniatura: x.thumb, precoMaisBaixoUSD: x.cheapest
      }));
    },
    async epic(q) {
      const d = await getJSON("https://www.cheapshark.com/api/1.0/deals?storeID=25&pageSize=10&title=" + encodeURIComponent(q));
      return d.map((x) => ({
        fonte: "Epic Games", nome: x.title, epic: true, steam: x.steamAppID ? Number(x.steamAppID) : undefined, p: ["PC"],
        y: x.releaseDate ? new Date(x.releaseDate * 1000).getFullYear() : undefined,
        capa: x.steamAppID ? steamCover(x.steamAppID)[0] : x.thumb, miniatura: x.thumb,
        precoUSD: x.salePrice, nota: x.metacriticScore && x.metacriticScore !== "0" ? Number(x.metacriticScore) : undefined
      }));
    },
    async wiki(q) { // consoles, mobile, arcade…
      const d = await getJSON("https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*" +
        "&generator=search&gsrlimit=10&gsrsearch=" + encodeURIComponent(q + " video game") +
        "&prop=pageimages|description&piprop=thumbnail&pithumbsize=600&pilicense=any");
      const pages = (d.query && d.query.pages || []).sort((a, b) => a.index - b.index);
      return pages.filter((p) => /game|arcade|jogo/i.test(p.description || "")).map((p) => {
        const desc = p.description || "";
        const ano = (desc.match(/(19|20)\d{2}/) || [])[0];
        return {
          fonte: "Wikipédia", nome: p.title.replace(/\s*\((\d{4} )?(video|arcade) game\)$/i, ""), w: wikiKey(p.title),
          y: ano ? Number(ano) : undefined, p: /arcade/i.test(desc) ? ["Arcade"] : [],
          capa: p.thumbnail && p.thumbnail.source, descricao: desc
        };
      });
    },
    async rawg(q) {
      if (!config.rawgKey) throw new Error("RAWG precisa de chave: GameAPI.configurar({rawgKey:'SUA_CHAVE'})");
      const d = await getJSON("https://api.rawg.io/api/games?page_size=10&key=" + encodeURIComponent(config.rawgKey) + "&search=" + encodeURIComponent(q));
      return (d.results || []).map((x) => {
        const p = new Set();
        (x.platforms || []).forEach((pp) => { const nm = pp.platform.name; RAWG_PLAT.forEach(([re, v]) => re.test(nm) && p.add(v)); });
        return {
          fonte: "RAWG", nome: x.name, y: x.released ? Number(x.released.slice(0, 4)) : undefined,
          s: x.rating ? Math.max(1, Math.round(x.rating)) : undefined, p: [...p],
          g: (x.genres || []).map((gg) => RAWG_GEN[gg.slug]).filter(Boolean),
          capa: x.background_image, rawgId: x.id
        };
      });
    }
  };

  /** Pesquisa jogos em fontes externas.
      fonte: "steam" | "epic" | "wiki" | "rawg" | "todas" (padrão) */
  async function pesquisar(termo, opts) {
    if (!termo) throw new Error("Informe um termo de busca");
    const fonte = (opts && opts.fonte) || "todas";
    const use = fonte === "todas" ? ["steam", "epic", "wiki"].concat(config.rawgKey ? ["rawg"] : []) : [fonte];
    const res = await Promise.allSettled(use.map((f) => fontes[f] ? fontes[f](termo) : Promise.reject(new Error("Fonte desconhecida: " + f))));
    const out = [];
    res.forEach((r, i) => r.status === "fulfilled" ? out.push(...r.value) : console.warn("[GameAPI] " + use[i] + ":", r.reason.message));
    return out;
  }

  /** Salva um resultado de pesquisar() no banco do usuário (aparece no site na hora).
      extras permite completar/corrigir: {p:[...], g:[...], t:"sinopse", s:4, y:2020} */
  async function importar(resultado, extras) {
    if (!resultado) throw new Error("Passe um resultado de GameAPI.pesquisar()");
    const r = Object.assign({}, resultado, extras || {});
    const dados = {
      n: r.n || r.nome, y: r.y, s: r.s || (r.nota ? Math.round(r.nota / 20) : 4), p: r.p || [], g: r.g || [], t: r.t || "",
      steam: r.steam, epic: r.epic, w: r.w, fonte: r.fonte,
      img: r.steam ? undefined : r.capa // Steam já tem capa vertical própria
    };
    if (!dados.t) {
      try { dados.t = (await info(decorate(dados))).sinopse || ""; } catch (e) { /* sem sinopse */ }
    }
    return adicionar(dados);
  }

  /* ---------------- exportação ---------------- */
  function linhaExport(g) {
    return {
      id: g.id, nome: g.n, ano: g.y, nota: g.s, plataformas: g.p, generos: g.g, lojas: g.lojas, sinopse: g.t,
      steamAppId: g.steam || null, epic: !!g.epic,
      wikipedia: g.w ? "https://en.wikipedia.org/wiki/" + encodeURIComponent(g.w) : null,
      lojaSteam: g.steam ? "https://store.steampowered.com/app/" + g.steam : null,
      capa: capa(g), capasAlternativas: capas(g).slice(1), origem: g.id >= USER_ID_BASE ? (g.fonte || "usuário") : "catálogo"
    };
  }
  function download(nome, conteudo, tipo) {
    const blob = new Blob([conteudo], { type: tipo });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  /** Exporta capas + informações. formato: "json" (padrão) | "csv". baixar=false só retorna os dados. */
  function exportar(formato, baixar) {
    formato = (formato || "json").toLowerCase();
    const rows = jogos().map(linhaExport);
    const stamp = new Date().toISOString().slice(0, 10);
    let out, tipo, ext;
    if (formato === "csv") {
      const cols = ["id", "nome", "ano", "nota", "plataformas", "generos", "lojas", "steamAppId", "capa", "wikipedia", "lojaSteam", "sinopse"];
      const esc = (v) => { v = Array.isArray(v) ? v.join(" | ") : (v == null ? "" : String(v)); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      out = "\ufeff" + cols.join(";") + "\n" + rows.map((r) => cols.map((c) => esc(r[c])).join(";")).join("\n");
      tipo = "text/csv;charset=utf-8"; ext = "csv";
    } else {
      out = JSON.stringify({ exportadoEm: new Date().toISOString(), versao: DB.version, total: rows.length, plataformas: DB.platforms, generos: DB.genres, jogos: rows }, null, 2);
      tipo = "application/json"; ext = "json";
    }
    if (baixar !== false) download("game-shuffle-" + stamp + "." + ext, out, tipo);
    return formato === "csv" ? out : JSON.parse(out);
  }

  /* ---------------- configuração ---------------- */
  function configurar(c) { config = Object.assign(config, c || {}); writeLS(LS_CONF, config); return Object.assign({}, config); }

  window.GameAPI = {
    versao: "1.1.0",
    plataformas: DB.platforms.slice(),
    generos: DB.genres.slice(),
    // banco
    jogos, jogo, buscarLocal, sortear, adicionar, remover,
    // capas & informações
    capas, capa, marcarFalha, carregarCapas, limparCache, info, testarFontes, diagnostico, fonteOk, IMG_TIMEOUT,
    // fontes externas
    pesquisar, importar, fontes,
    // exportação
    exportar,
    configurar
  };
})();

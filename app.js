/* Hunting Box - Shard-Tracker
   Laeuft komplett im Browser. Der API-Key geht nur an api.hypixel.net. */

"use strict";

/* Bei jedem Update hochzaehlen (dieselbe Zahl wie in index.html), damit
   Browser und GitHub Pages keine alten Dateien aus dem Cache nehmen. */
const VERSION = "20261017d";

const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

/* Shards pro Stufe (1..10) je Rarity. Summe = Shards bis Level 10. */
const LEVEL_COSTS = {
  Common:    [1, 3, 5, 6, 7, 8, 10, 14, 18, 24],
  Uncommon:  [1, 2, 3, 4, 5, 6, 7, 8, 12, 16],
  Rare:      [1, 2, 3, 3, 4, 4, 5, 6, 8, 12],
  Epic:      [1, 1, 2, 2, 3, 3, 4, 4, 5, 7],
  Legendary: [1, 1, 1, 2, 2, 2, 3, 3, 4, 5],
};

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* Privat-Modus */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

const state = {
  db: null,
  byAttrId: new Map(),
  profiles: [],
  uuid: null,
  playerName: "",
  rows: [],          // aufbereitete Zeilen des aktiven Profils
  view: "progress",
  totals: null,
  detailId: null,
  detailOwnedOnly: false,
  detailReadyOnly: false,
  recipes: null,
  recipesTried: false,
  rowById: new Map(),
  shardIdIndex: new Map(),
  mode: "box",       // "box" = Raster mit Koepfen, "cards" = Karten
  tipId: null,
};

/* ---------- Rechnen ---------- */

function levelOf(count, rarity) {
  const costs = LEVEL_COSTS[rarity] || LEVEL_COSTS.Common;
  const max = costs.reduce((a, b) => a + b, 0);
  let level = 0, cum = 0;
  for (const c of costs) {
    if (count >= cum + c) { level++; cum += c; } else break;
  }
  const nextCost = level < 10 ? costs[level] : 0;
  return {
    level,
    max,
    remaining: Math.max(0, max - count),
    intoLevel: count - cum,
    nextCost,
  };
}

/* ---------- Daten holen ---------- */

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    err.status = res.status;
    try { err.body = await res.json(); } catch { /* kein JSON */ }
    throw err;
  }
  return res.json();
}

/* Die Mojang-API schickt keinen CORS-Header, deshalb ueber offene Spiegel. */
async function resolveUuid(name) {
  try {
    const d = await getJSON("https://api.ashcon.app/mojang/v2/user/" + encodeURIComponent(name));
    if (d && d.uuid) return { uuid: d.uuid.replace(/-/g, ""), name: d.username || name };
  } catch { /* naechster Versuch */ }

  const d = await getJSON("https://playerdb.co/api/player/minecraft/" + encodeURIComponent(name));
  const p = d && d.data && d.data.player;
  if (!p || !p.raw_id) throw new Error("nouser");
  return { uuid: p.raw_id.replace(/-/g, ""), name: p.username || name };
}

async function fetchProfiles(uuid, key) {
  const url = "https://api.hypixel.net/v2/skyblock/profiles?uuid=" + uuid + "&key=" + encodeURIComponent(key);
  const data = await getJSON(url);
  if (!data.success) throw new Error(data.cause || "API-Fehler");
  return data.profiles || [];
}

/* ---------- Profil auswerten ---------- */

/* Die API nennt Shards mal "ZEALOT", mal "SHARD_ZEALOT", mal per Attribut-ID
   ("nocturnal_animal"). Alle drei Schreibweisen auf den DB-Schluessel bringen. */
function resolveShardId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const upper = s.toUpperCase().replace(/\s+/g, "_");
  if (state.db[upper]) return upper;
  if (state.db["SHARD_" + upper]) return "SHARD_" + upper;
  return state.byAttrId.get(s.toLowerCase()) || null;
}

function readMember(member) {
  const syphoned = new Map();   // api_id -> Anzahl syphont
  const inBox = new Map();      // api_id -> Anzahl in der Hunting Box

  const unknown = [];
  const stacks = (member.attributes && member.attributes.stacks) || {};
  for (const [k, v] of Object.entries(stacks)) {
    const id = resolveShardId(k);
    if (id) syphoned.set(id, (syphoned.get(id) || 0) + (Number(v) || 0));
    else if (Number(v) > 0) unknown.push(k);
  }
  state.unknownAttrs = unknown;

  const owned = (member.shards && member.shards.owned) || [];
  for (const e of owned) {
    const id = resolveShardId(e && e.type);
    if (id) inBox.set(id, (inBox.get(id) || 0) + (Number(e.amount_owned) || 0));
  }
  return { syphoned, inBox };
}

function buildRows(member) {
  const { syphoned, inBox } = readMember(member);
  const rows = [];
  let unlocked = 0, maxed = 0, toMax = 0;

  let total = 0;
  for (const [id, info] of Object.entries(state.db)) {
    // Manche Shards kann man gar nicht syphonen (Chameleon) - die sind reines
    // Fusionsmaterial und zaehlen in keiner Syphon-Statistik mit.
    const fusionOnly = info.syphonable === false;
    const count = !fusionOnly && syphoned.has(id) ? syphoned.get(id) : null;
    const lv = levelOf(count || 0, info.rarity);
    if (!fusionOnly) total++;
    if (count !== null) {
      unlocked++;
      toMax += lv.remaining;
      if (lv.remaining === 0) maxed++;
    }
    const box = inBox.get(id) || 0;
    // Was bringt es, die Box-Shards dieser Sorte zu syphonen? Nur so viele,
    // wie bis Level 10 noch fehlen - der Rest ist nur noch Fusionsmaterial.
    const usable = fusionOnly ? 0 : Math.min(box, lv.remaining);
    const after = usable ? levelOf((count || 0) + usable, info.rarity).level : lv.level;
    rows.push({
      id, info,
      count,
      box,
      unlocked: count !== null,
      fusionOnly,
      usable,
      levelAfter: after,
      ...lv,
    });
  }

  state.rowById = new Map(rows.map((r) => [r.id, r]));

  state.totals = {
    total,
    all: rows.length,
    unlocked,
    maxed,
    inProgress: unlocked - maxed,
    missing: total - unlocked,
    toMax,
    readyToSyphon: rows.filter((r) => !r.unlocked && !r.fusionOnly && r.box > 0).length,
    boxTypes: rows.filter((r) => r.box > 0).length,
    syphonable: rows.filter((r) => r.usable > 0).length,
    syphonUnlocks: rows.filter((r) => r.usable > 0 && !r.unlocked).length,
    syphonLevels: rows.reduce((s, r) => s + (r.usable ? r.levelAfter - r.level : 0), 0),
    boxMaxedOnly: rows.filter((r) => r.box > 0 && r.usable === 0).length,
  };
  return rows;
}

/* ---------- Anzeige ---------- */

function renderSummary(profile) {
  const t = state.totals;
  $("playerName").textContent = state.playerName;

  const sel = $("profileSelect");
  sel.innerHTML = "";
  state.profiles.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.cute_name || "Profil " + (i + 1);
    if (p === profile) o.selected = true;
    sel.appendChild(o);
  });

  const cells = [
    ["freigeschaltet", `${t.unlocked}<span class="stat-l"> / ${t.total}</span>`, ""],
    ["auf Level 10", String(t.maxed), "is-good"],
    ["angefangen", String(t.inProgress), ""],
    ["nie syphont", String(t.missing), "is-warn"],
    ["Shards bis alles Lvl 10", t.toMax.toLocaleString("de-DE"), ""],
  ];
  $("stats").innerHTML = cells.map(([label, value, cls]) =>
    `<div class="stat ${cls}"><span class="stat-n">${value}</span><span class="stat-l">${label}</span></div>`
  ).join("");

  const unknown = state.unknownAttrs || [];
  const warn = $("unknown");
  warn.hidden = unknown.length === 0;
  if (unknown.length) {
    const one = unknown.length === 1;
    warn.textContent = `${unknown.length} Attribut${one ? "" : "e"} aus deinem Profil `
      + `${one ? "passt" : "passen"} zu keinem bekannten Shard: ${unknown.slice(0, 6).join(", ")}`
      + (unknown.length > 6 ? " u.a." : "")
      + `. ${one ? "Es fehlt" : "Die fehlen"} in der Zaehlung - bitte melden.`;
  }

  const ready = $("ready");
  ready.hidden = t.boxTypes === 0;
  if (t.boxTypes) {
    const parts = [];
    if (t.syphonable) {
      const unlock = !t.syphonUnlocks ? ""
        : t.syphonable === 1 ? ", schaltet ein neues Attribut frei"
        : `, ${t.syphonUnlocks} davon ${t.syphonUnlocks === 1 ? "schaltet ein neues Attribut" : "schalten neue Attribute"} frei`;
      parts.push(`<b>${t.syphonable}</b> davon kannst du noch syphonen (+${t.syphonLevels} Level${unlock})`
        + ` &middot; <button type="button" class="linkish" data-goto="syphon">anzeigen</button>`);
      if (t.boxMaxedOnly) {
        parts.push(`<span class="dim">${t.boxMaxedOnly === 1 ? "Eine ist" : `Die anderen ${t.boxMaxedOnly} sind`} nur noch Fusionsmaterial (gemaxt oder nicht syphonbar)</span>`);
      }
    } else {
      parts.push(`<span class="dim">${t.boxTypes === 1 ? "Sie ist" : "Alle sind"} nur noch Fusionsmaterial (gemaxt oder nicht syphonbar)</span>`);
    }
    ready.innerHTML = `In deiner Hunting Box liegen ${t.boxTypes} Shard-Sorten. ` + parts.join(". ") + ".";
  }

  const pMax = (t.maxed / t.total) * 100;
  const pPart = (t.inProgress / t.total) * 100;
  $("meter").innerHTML =
    `<span class="m-max" style="width:${pMax}%"></span><span class="m-part" style="width:${pPart}%"></span>`;
}

function renderTabs() {
  const t = state.totals;
  const defs = [
    ["syphon", "Syphonbar", t.syphonable],
    ["fusable", "Jetzt fusebar", state.recipes ? (t.fusable || 0) : "\u2026"],
    ["progress", "Angefangen", t.inProgress],
    ["missing", "Nie syphont", t.missing],
    ["maxed", "Fertig", t.maxed],
    ["all", "Alle", t.all],
  ];
  $("tabs").innerHTML = defs.map(([key, label, n]) =>
    `<button class="tab" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}<b>${n}</b></button>`
  ).join("");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- Koepfe ---------- */

/* Die Textur kommt direkt von Mojangs Texturserver. Als CSS-Hintergrund
   braucht das kein CORS, und der Browser cached jedes Bild nur einmal. */
function skinUrl(info) {
  if (info && info.skin && /^[0-9a-f]+$/.test(info.skin)) {
    return `https://textures.minecraft.net/texture/${info.skin}`;
  }
  // Eigene Icons aus icons/ fuer Shards, die im Spiel Bloecke sind
  if (info && info.icon && /^icons\/[\w.-]+\.png$/.test(info.icon)) {
    return `${info.icon}?v=${VERSION}`;
  }
  return null;
}

/* 3D-Kopf wie im Inventar. Shards ohne Kopf (Sea Lantern, Packed Ice ...)
   bekommen den Kristall in Rarity-Farbe. */
function headHTML(info, extra = "") {
  const url = skinUrl(info);
  const rc = "r-" + info.rarity;
  if (!url) {
    return `<span class="head no-skin ${rc} ${extra}"><span class="shard-mark"></span></span>`;
  }
  if (info.icon_kind === "sprite") {
    return `<span class="head local sprite ${rc} ${extra}" style="--skin:url(${url})"></span>`;
  }
  const kind = info.icon_kind === "block" ? " local block" : "";
  return `<span class="head${kind} ${rc} ${extra}" style="--skin:url(${url})"><span class="cube">`
    + `<i class="t"></i><i class="fr"></i><i class="sd"></i>`
    + `<i class="h t"></i><i class="h fr"></i><i class="h sd"></i>`
    + `</span><span class="shard-mark"></span></span>`;
}

/* Flaches Gesicht fuer Listen */
function faceHTML(info) {
  const url = skinUrl(info);
  if (url && info.icon_kind === "sprite") {
    return `<span class="face sprite" style="--skin:url(${url})" aria-hidden="true"></span>`;
  }
  return url
    ? `<span class="face" style="--skin:url(${url})" aria-hidden="true"></span>`
    : `<span class="face no-skin r-${info.rarity}" aria-hidden="true"></span>`;
}

/* Ein Inventar-Slot: Kopf, Level als Stack-Zahl, Haltbarkeitsbalken */
function islotHTML(row) {
  const i = row.info;
  const p = row.unlocked ? Math.min(1, row.count / row.max) : 0;
  const cnt = row.unlocked && row.level > 0
    ? `<span class="cnt${row.remaining === 0 ? " max" : ""}">${row.level}</span>` : "";
  const bar = row.unlocked && row.remaining > 0
    ? `<span class="dura"><i style="width:${Math.max(1, Math.round(p * 13)) / 13 * 100}%;background:hsl(${Math.round(p * 120)},100%,50%)"></i></span>`
    : "";
  const box = row.box > 0 ? `<span class="inbox${row.usable ? "" : " spent"}"></span>` : "";
  const label = `${i.name} Shard, ${i.rarity}, `
    + (row.fusionOnly ? "nur fuers Fusen" : row.unlocked ? `Level ${row.level} von 10` : "noch nie syphont")
    + (row.box ? `, ${row.box} in der Box` : "");
  return `<button type="button" class="islot${row.unlocked || row.fusionOnly ? "" : " is-missing"}" data-id="${esc(row.id)}" aria-label="${esc(label)}">`
    + headHTML(i) + box + bar + cnt + `</button>`;
}

/* Tooltip im Stil des Spiels, letzte Zeile wie die echte Shard-Lore */
function tipHTML(row) {
  const i = row.info;
  const lines = [
    `<p class="tt-name r-${i.rarity}">${esc(i.name)} Shard</p>`,
    `<p class="tt-attr">${esc(i.attribute || "")}${row.level ? " " + ROMAN[row.level] : ""}</p>`,
    `<p class="tt-eff">${esc(i.effect || "")}</p>`,
  ];
  if (row.fusionOnly) {
    lines.push('<p class="tt-lv">Kann nicht syphont werden &mdash; nur fuers Fusen</p>');
  } else if (row.unlocked) {
    lines.push(`<p class="tt-lv">Level ${row.level}/10 &middot; ${row.count}/${row.max} Shards${
      row.remaining ? ` &middot; noch ${row.remaining}` : " &middot; gemaxt"}</p>`);
  } else {
    lines.push('<p class="tt-miss">Noch nie syphont</p>');
  }
  if (row.box) {
    lines.push(`<p class="tt-box">${row.box}x in deiner Hunting Box</p>`);
    if (row.usable && row.levelAfter > row.level) {
      lines.push(`<p class="tt-box">Syphonen bringt dich auf Level ${row.levelAfter}</p>`);
    } else if (row.usable) {
      lines.push(`<p class="tt-box">Syphonen bringt ${row.usable} Shards Fortschritt</p>`);
    } else if (row.unlocked) {
      lines.push('<p class="tt-eff">Schon gemaxt &mdash; nur noch fuer Fusionen</p>');
    }
    // bei Fusions-Shards steht der Hinweis schon oben
  }
  if ((row.ready || []).length) {
    const [a, b] = row.ready[0];
    lines.push(`<p class="tt-fuse">Jetzt fusebar: ${esc(a.info.name)} &times;${need(a)} + ${esc(b.info.name)} &times;${need(b)}</p>`);
  }
  lines.push(`<p class="tt-foot r-${i.rarity}">${esc(i.rarity.toUpperCase())} ${esc((i.category || "").toUpperCase())} SHARD (ID ${esc(i.shard_id)})</p>`);
  lines.push('<p class="tt-hint">Klick fuer Details und Fusionen</p>');
  return lines.join("");
}

function cardHTML(row) {
  const i = row.info;
  const rc = "r-" + i.rarity;
  const direct = i.direct_methods || [];
  const rules = i.fusion_rules || [];
  const examples = i.fusion_examples || [];

  const pips = Array.from({ length: 10 }, (_, n) =>
    `<span class="pip${n < row.level ? " on" : ""}"></span>`).join("");

  const levelBlock = row.fusionOnly
    ? '<p class="level-num" style="margin-top:.8rem">Kann nicht syphont werden &mdash; nur fuers Fusen</p>'
    : row.unlocked
    ? `<div class="level ${rc}">
         <span class="pips">${pips}</span>
         <span class="roman">${ROMAN[row.level] || "-"}</span>
         <span class="level-num">${row.count}/${row.max} Shards${row.remaining ? ` &middot; noch ${row.remaining}` : " &middot; fertig"}</span>
       </div>`
    : "";

  const lore = [];
  if (direct.length) {
    lore.push('<p class="lbl">So bekommst du ihn</p>');
    direct.forEach((m) => lore.push(`<p class="how">&bull; ${esc(m)}</p>`));
  } else {
    lore.push('<p class="lbl">Nicht jagdbar &mdash; nur ueber die Fusion</p>');
  }
  rules.forEach((r) => lore.push(`<p class="rule">&bull; ${esc(r)}</p>`));
  if (examples.length) {
    lore.push('<p class="lbl" style="margin-top:.5rem">Fertige Kombis</p>');
    examples.slice(0, 2).forEach((e) => lore.push(`<p class="fuse">&bull; ${esc(e)}</p>`));
  }

  const readyLine = (row.ready || []).length
    ? `<p class="ready-now"><span class="ready-dot"></span>Jetzt fusebar: ${
        esc(row.ready[0][0].info.name)} &times;${need(row.ready[0][0])} + ${
        esc(row.ready[0][1].info.name)} &times;${need(row.ready[0][1])}${
        row.ready.length > 1 ? ` <span class="ready-more">+${row.ready.length - 1} weitere</span>` : ""}</p>`
    : "";

  const tags = [];
  if (row.box > 0) {
    const gain = row.usable && row.levelAfter > row.level ? ` &rarr; Lvl ${row.levelAfter}` : "";
    tags.push(`<span class="tag box${row.usable ? "" : " spent"}">${row.box}x in der Box${gain}</span>`);
  }
  if (!direct.length) tags.push('<span class="tag fusion-only">nur Fusion</span>');
  tags.push(`<span class="tag">${esc(i.category)}</span>`);
  if (i.type) tags.push(`<span class="tag">${esc(i.type)}</span>`);
  (i.family || []).forEach((f) => tags.push(
    `<button type="button" class="tag fam" data-family="${esc(f)}" aria-pressed="false" title="Nach dieser Familie filtern">${esc(f)}</button>`));

  return `<article class="card" data-id="${esc(row.id)}" tabindex="0" role="button" aria-label="${esc(i.name)} Shard - Details">
    <div class="card-top ${rc}">
      ${headHTML(i)}
      <h3>${esc(i.name)}</h3>
      <span class="rar">${esc(i.rarity)}</span>
    </div>
    <p class="attr">${esc(i.attribute || "")}</p>
    <p class="effect">${esc(i.effect || "")}</p>
    ${levelBlock}
    ${readyLine}
    <div class="lore">${lore.join("")}</div>
    <div class="tags">${tags.join("")}</div>
  </article>`;
}

function visibleRows() {
  const q = $("search").value.trim().toLowerCase();
  const fr = $("fRarity").value;
  const fc = $("fCategory").value;
  const ff = $("fFamily").value;
  const fs = $("fSource").value;
  const sort = $("fSort").value;

  let rows = state.rows.filter((r) => {
    if (r.fusionOnly && !["all", "fusable"].includes(state.view)) return false;
    if (state.view === "syphon" && !(r.usable > 0)) return false;
    if (state.view === "fusable" && !(r.ready || []).length) return false;
    if (state.view === "progress" && !(r.unlocked && r.remaining > 0)) return false;
    if (state.view === "missing" && r.unlocked) return false;
    if (state.view === "maxed" && !(r.unlocked && r.remaining === 0)) return false;
    if (fr && r.info.rarity !== fr) return false;
    if (fc && r.info.category !== fc) return false;
    if (ff && !(r.info.family || []).includes(ff)) return false;
    const isDirect = (r.info.direct_methods || []).length > 0;
    if (fs === "direct" && !isDirect) return false;
    if (fs === "fusion" && isDirect) return false;
    if (q) {
      const hay = [
        r.info.name, r.info.attribute, r.info.effect, r.info.category, r.info.type,
        (r.info.family || []).join(" "),
        (r.info.direct_methods || []).join(" "),
        (r.info.fusion_rules || []).join(" "),
        (r.info.fusion_examples || []).join(" "),
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const byName = (a, b) => a.info.name.localeCompare(b.info.name);
  if (sort === "name") rows.sort(byName);
  else if (sort === "rarity") rows.sort((a, b) =>
    RARITIES.indexOf(a.info.rarity) - RARITIES.indexOf(b.info.rarity) || byName(a, b));
  else if (sort === "remaining") rows.sort((a, b) => a.remaining - b.remaining || byName(a, b));
  else if (state.view === "syphon") rows.sort((a, b) =>
    a.unlocked - b.unlocked ||
    (b.levelAfter - b.level) - (a.levelAfter - a.level) || byName(a, b));
  else if (state.view === "fusable") rows.sort((a, b) =>
    a.unlocked - b.unlocked || a.level - b.level ||
    RARITIES.indexOf(b.info.rarity) - RARITIES.indexOf(a.info.rarity) || byName(a, b));
  else if (state.view === "progress") rows.sort((a, b) => b.level - a.level || a.remaining - b.remaining);
  else if (state.view === "missing") rows.sort((a, b) =>
    (b.box > 0) - (a.box > 0) ||
    ((a.info.direct_methods || []).length === 0) - ((b.info.direct_methods || []).length === 0) ||
    RARITIES.indexOf(a.info.rarity) - RARITIES.indexOf(b.info.rarity) || byName(a, b));
  else rows.sort(byName);

  return rows;
}

const CATEGORY_ORDER = ["Forest", "Water", "Combat"];

function boxHTML(rows) {
  const groups = new Map();
  for (const r of rows) {
    const c = r.info.category || "Sonstige";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  const order = [...groups.keys()].sort((a, b) =>
    (CATEGORY_ORDER.indexOf(a) + 99) % 99 - (CATEGORY_ORDER.indexOf(b) + 99) % 99);
  return order.map((c) => {
    const list = groups.get(c);
    return `<section class="cat"><h4 class="cat-h">${esc(c)}<span>${list.length}</span></h4>`
      + `<div class="islots">${list.map(islotHTML).join("")}</div></section>`;
  }).join("");
}

function renderGrid() {
  const rows = visibleRows();
  const cards = state.mode === "cards";
  $("box").classList.toggle("is-cards", cards);
  $("grid").className = cards ? "cards" : "";
  $("grid").innerHTML = cards ? rows.map(cardHTML).join("") : boxHTML(rows);
  $("legend").hidden = cards || !rows.length;
  hideTip();
  const active = $("fFamily").value;
  if (active) {
    $("grid").querySelectorAll(`.tag.fam[data-family="${CSS.escape(active)}"]`)
      .forEach((el) => el.setAttribute("aria-pressed", "true"));
  }
  $("empty").hidden = rows.length > 0;
  if (!rows.length && state.view === "fusable") {
    $("empty").textContent = state.recipes
      ? "Mit dem aktuellen Box-Bestand laesst sich gerade nichts fusen."
      : "Kombis werden geladen \u2026";
  } else if (!rows.length) {
    $("empty").textContent = "Nichts gefunden. Filter zuruecksetzen?";
  }
  $("count").textContent = rows.length
    ? `${rows.length} ${rows.length === 1 ? "Shard" : "Shards"}`
    : "";
}

function renderAll(profile) {
  renderSummary(profile);
  renderTabs();
  renderGrid();
}

/* ---------- Fusions-Regeln ---------- */

/* Regelsyntax aus den Quelldaten:
   "&" = und, "|" = oder, "Rare+" = Rare oder hoeher,
   "Kraken Shard" = genau dieser Shard, "Mining Shards" = Attribut-Bereich Mining. */
function matchesRule(rule, info) {
  if (!rule) return false;
  return rule.split("&").every((andPart) =>
    andPart.split("|").some((atom) => {
      const a = atom.trim();
      if (!a) return false;
      if (a.endsWith(" Shard")) return info.name === a.slice(0, -6);
      if (a.endsWith(" Shards")) return info.type === a.slice(0, -7);
      const bare = a.endsWith("+") ? a.slice(0, -1) : a;
      if (RARITIES.includes(bare)) {
        return a.endsWith("+")
          ? RARITIES.indexOf(info.rarity) >= RARITIES.indexOf(bare)
          : info.rarity === bare;
      }
      if (["Forest", "Water", "Combat"].includes(a)) return info.category === a;
      // Familie oder Attribut-Bereich. Die Quelle schreibt den Bereich mal als
      // "Mining Shards", mal nur als "Mining" - beides muss greifen.
      return (info.family || []).includes(a) || info.type === a;
    }));
}

function ruleText(rule) {
  return rule.split("&")
    .map((p) => p.split("|").map((s) => s.trim()).join(" oder "))
    .join(" + ");
}

function candidates(rule, excludeId) {
  if (!rule) return [];
  return state.rows
    .filter((r) => r.id !== excludeId && matchesRule(rule, r.info))
    .sort((a, b) =>
      (b.box > 0) - (a.box > 0) ||
      b.box - a.box ||
      ((a.info.direct_methods || []).length === 0) - ((b.info.direct_methods || []).length === 0) ||
      RARITIES.indexOf(a.info.rarity) - RARITIES.indexOf(b.info.rarity) ||
      a.info.name.localeCompare(b.info.name));
}

function slotHTML(label, rule, onlyOwned, excludeId) {
  if (!rule) {
    return `<div class="slot"><div class="slot-h"><b>${label}</b></div>
      <p class="d-none">Kein zweiter Shard noetig.</p></div>`;
  }
  let list = candidates(rule, excludeId);
  const total = list.length;
  if (onlyOwned) list = list.filter((r) => r.box > 0);

  const items = list.map((r) => {
    const noDirect = (r.info.direct_methods || []).length === 0;
    const st = r.box > 0
      ? `<span class="st have">${r.box}x in der Box</span>`
      : `<span class="st">${r.unlocked ? "Lvl " + r.level : "noch nie"}</span>`;
    return `<li><button type="button" class="pick r-${r.info.rarity}" data-open="${esc(r.id)}">
      ${faceHTML(r.info)}
      <span class="nm">${esc(r.info.name)}</span>
      ${noDirect ? '<span class="only-fusion">nur Fusion</span>' : ""}
      ${st}
    </button></li>`;
  }).join("");

  return `<div class="slot">
    <div class="slot-h"><b>${label}</b><span class="slot-rule">${esc(ruleText(rule))}</span>
      <span class="slot-n">${onlyOwned ? list.length + " / " + total : total}</span></div>
    ${items ? `<ul class="slot-list">${items}</ul>` : '<p class="d-none">Nichts davon liegt in deiner Box.</p>'}
  </div>`;
}

/* Fuer Shards ohne allgemeine Regel liegen die konkreten Kombis in recipes.json.
   Die Datei ist gross, also erst beim ersten Detail-Klick holen. */
async function loadRecipes() {
  if (state.recipes || state.recipesTried) return;
  state.recipesTried = true;
  try {
    state.recipes = await getJSON("recipes.json?v=" + VERSION);
  } catch {
    state.recipes = {};
  }
}

function comboList(id) {
  const raw = (state.recipes || {})[id];
  if (!raw) return [];
  const byShardId = state.shardIdIndex;
  return raw.map(([a, b, qty]) => {
    const ra = state.rowById.get(byShardId.get(a));
    const rb = state.rowById.get(byShardId.get(b));
    if (!ra || !rb) return null;
    // "bereit" heisst: genug Stueck von beiden Zutaten fuer eine Fusion
    const same = ra.id === rb.id;
    const ready = same ? haveEnough(ra, 2) : haveEnough(ra, 1) && haveEnough(rb, 1);
    return { a: ra, b: rb, qty: qty || 1, ready, half: !ready && (ra.box > 0 || rb.box > 0) };
  }).filter(Boolean).sort((x, y) =>
    y.ready - x.ready ||
    y.half - x.half ||
    (RARITIES.indexOf(x.a.info.rarity) + RARITIES.indexOf(x.b.info.rarity)) -
    (RARITIES.indexOf(y.a.info.rarity) + RARITIES.indexOf(y.b.info.rarity)) ||
    x.a.info.name.localeCompare(y.a.info.name));
}

/* Was laesst sich mit dem aktuellen Box-Bestand sofort fusen?
   Pro Zutat wird ihre eigene fuse_amount-Menge verbraucht (2 oder 5 Stueck). */
function need(row) {
  return Number(row.info.fuse_amount) || 1;
}

function haveEnough(row, times) {
  return row.box >= need(row) * times;
}

function computeFusable() {
  const box = state.rows.filter((r) => r.box > 0);
  let count = 0;

  for (const row of state.rows) {
    const ready = [];
    const [r1, r2] = row.info.fuse_inputs || ["", ""];

    if (r1) {
      for (const a of box) {
        if (a.id === row.id || !matchesRule(r1, a.info)) continue;
        for (const b of box) {
          if (b.id === row.id || !matchesRule(r2 || r1, b.info)) continue;
          const same = a.id === b.id;
          if (!haveEnough(a, same ? 2 : 1) || (!same && !haveEnough(b, 1))) continue;
          ready.push([a, b]);
          if (ready.length >= 6) break;
        }
        if (ready.length >= 6) break;
      }
    } else {
      for (const c of comboList(row.id)) {
        const same = c.a.id === c.b.id;
        if (!haveEnough(c.a, same ? 2 : 1) || (!same && !haveEnough(c.b, 1))) continue;
        ready.push([c.a, c.b]);
        if (ready.length >= 6) break;
      }
    }

    row.ready = ready;
    if (ready.length) count++;
  }

  state.totals.fusable = count;
  return count;
}

function ingredientHTML(r) {
  const st = r.box > 0 ? `<span class="ing-box">${r.box}x</span>` : "";
  return `<button type="button" class="ing r-${r.info.rarity}" data-open="${esc(r.id)}">${faceHTML(r.info)}<span class="ing-nm">${esc(r.info.name)}</span>${st}</button>`;
}

function combosHTML(id, onlyReady) {
  let list = comboList(id);
  const total = list.length;
  if (!total) return "";
  if (onlyReady) list = list.filter((c) => c.ready);

  const CAP = 200;
  const shown = list.slice(0, CAP);
  const items = shown.map((c) => `<li class="combo${c.ready ? " is-ready" : ""}">
      ${ingredientHTML(c.a)}<span class="plus">+</span>${ingredientHTML(c.b)}
      ${c.qty > 1 ? `<span class="qty">= ${c.qty}x</span>` : ""}
    </li>`).join("");

  return `<div class="d-block">
    <h3>Alle Kombis, die diesen Shard ergeben</h3>
    <label class="d-filter"><input type="checkbox" id="readyOnly" ${onlyReady ? "checked" : ""}>
      <span>Nur Kombis, die ich mit meiner Box sofort fusen kann</span></label>
    <p class="d-none">${onlyReady ? `${list.length} von ${total}` : `${total} Kombis`}${
      list.length > CAP ? ` &middot; zeigt die ersten ${CAP}` : ""}</p>
    ${items ? `<ul class="combo-list">${items}</ul>`
            : '<p class="d-none">Mit deinem Box-Bestand reicht es fuer keine dieser Kombis.</p>'}
  </div>`;
}

function openDetail(id) {
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  state.detailId = id;

  const i = row.info;
  const rc = "r-" + i.rarity;
  const [r1, r2] = i.fuse_inputs || ["", ""];
  const onlyOwned = state.detailOwnedOnly;
  const direct = i.direct_methods || [];

  const status = row.fusionOnly
    ? "Kann nicht syphont werden &mdash; nur fuers Fusen"
    : row.unlocked
    ? `Level ${ROMAN[row.level]} &middot; ${row.count}/${row.max} Shards${row.remaining ? ` &middot; noch ${row.remaining}` : " &middot; fertig"}`
    : "Noch nie syphont";

  const parts = [`
    <div class="d-top">
      ${islotHTML(row).replace("<button", '<div role="img"').replace(/<\/button>$/, "</div>")}
      <div>
        <div class="d-head ${rc}">
          <h2>${esc(i.name)} Shard</h2>
          <span class="rar">${esc(i.rarity)} &middot; ${esc(i.category || "")}</span>
        </div>
        <p class="d-attr">${esc(i.attribute || "")}</p>
        <p class="d-effect">${esc(i.effect || "")}</p>
        <p class="d-effect">${status}${row.box ? ` &middot; <span style="color:var(--good)">${row.box}x in der Box</span>` : ""}</p>
      </div>
    </div>`];

  if (direct.length) {
    parts.push(`<div class="d-block"><h3>So bekommst du ihn</h3><div class="d-lore">
      ${direct.map((m) => `<p class="how">&bull; ${esc(m)}</p>`).join("")}</div></div>`);
  }

  if (r1 || r2) {
    parts.push(`<div class="d-block">
      <h3>Fusion</h3>
      <div class="d-lore">${(i.fusion_rules || []).map((x) => `<p class="rule">&bull; ${esc(x)}</p>`).join("")}</div>
      <label class="d-filter"><input type="checkbox" id="ownedOnly" ${onlyOwned ? "checked" : ""}>
        <span>Nur zeigen, was in meiner Box liegt</span></label>
      <div class="slots">
        ${slotHTML("Slot 1", r1, onlyOwned, id)}
        ${slotHTML("Slot 2", r2, onlyOwned, id)}
      </div>
    </div>`);
  }

  const combos = combosHTML(id, state.detailReadyOnly);
  if (combos) {
    if (!(r1 || r2)) {
      parts.push('<div class="d-block"><h3>Fusion</h3>' +
        '<p class="d-none">Fuer diesen Shard gibt es keine allgemeine Regel &mdash; ' +
        'er entsteht nur aus festen Kombinationen.</p></div>');
    }
    parts.push(combos);
  } else if (!(r1 || r2) && !direct.length) {
    parts.push('<div class="d-block"><p class="d-none">Fuer diesen Shard ist keine Fusion hinterlegt.</p></div>');
  }

  if (!combos && (i.fusion_examples || []).length) {
    parts.push(`<div class="d-block"><h3>Fertige Kombis</h3><div class="d-lore">
      ${i.fusion_examples.map((e) => `<p class="fuse">&bull; ${esc(e)}</p>`).join("")}</div></div>`);
  }

  $("detailBody").innerHTML = parts.join("");
  const dlg = $("detail");
  if (!dlg.open) dlg.showModal();

  if (!state.recipes && !i.fuse_inputs[0]) {
    loadRecipes().then(() => { if (state.detailId === id) openDetail(id); });
  }
}

/* ---------- CSV ---------- */

function downloadCSV() {
  const rows = visibleRows();
  const head = ["Shard", "Rarity", "Kategorie", "Attribut-Bereich", "Familie", "Attribut",
    "Level", "Syphont", "Max", "Fehlend", "In Box", "Direkt erhaeltlich",
    "Beschaffung", "Fusions-Regel", "Fusion Beispiel"];

  const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [head.map(cell).join(";")];

  for (const r of rows) {
    const i = r.info;
    const direct = i.direct_methods || [];
    lines.push([
      i.name + " Shard", i.rarity, i.category, i.type || "", (i.family || []).join(", "),
      i.attribute || "",
      r.unlocked ? r.level : "", r.unlocked ? r.count : "", r.max,
      r.fusionOnly ? "" : r.unlocked ? r.remaining : r.max, r.box,
      direct.length ? "Ja" : "Nein - nur Fusion",
      direct.join(" | "),
      (i.fusion_rules || []).join(" | "),
      (i.fusion_examples || []).slice(0, 2).join(" | "),
    ].map(cell).join(";"));
  }

  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `shards-${state.playerName || "export"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- Tooltip ---------- */

function hideTip() {
  const tip = $("tip");
  if (tip) tip.hidden = true;
  state.tipId = null;
}

function moveTip(x, y) {
  const tip = $("tip");
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}

function onGridPointer(e) {
  if (e.pointerType && e.pointerType !== "mouse") return;
  const slot = e.target.closest(".islot");
  if (!slot) { hideTip(); return; }
  if (state.tipId !== slot.dataset.id) {
    const row = state.rowById.get(slot.dataset.id);
    if (!row) return;
    state.tipId = slot.dataset.id;
    $("tip").innerHTML = tipHTML(row);
    $("tip").hidden = false;
  }
  moveTip(e.clientX, e.clientY);
}

/* ---------- Vitrine und Textur-Check ---------- */

function fillShowcase() {
  const pool = Object.values(state.db).filter((i) => skinUrl(i));
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  $("showcase").innerHTML = pool.slice(0, 9).map((i) =>
    `<span class="islot" title="${esc(i.name)} Shard">${headHTML(i)}</span>`).join("");
}

/* Ist textures.minecraft.net erreichbar? Wenn nicht (Firmennetz, Adblocker),
   zeigen alle Koepfe den Kristall statt leerer Slots. */
function probeSkins() {
  const first = Object.values(state.db).find((i) => i.skin && skinUrl(i));
  if (!first) return;
  const img = new Image();
  img.onerror = () => document.documentElement.classList.add("no-skins");
  img.src = skinUrl(first);
}

function setMode(mode) {
  state.mode = mode === "cards" ? "cards" : "box";
  store.set("hb_view", state.mode);
  document.querySelectorAll(".viewswitch button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
  if (state.rows.length) renderGrid();
}

/* ---------- Ablauf ---------- */

function say(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

function showProfile(index) {
  const profile = state.profiles[index];
  const member = (profile.members || {})[state.uuid];
  if (!member) {
    say("In diesem Profil liegen keine Daten fuer den Account.", "err");
    return;
  }
  state.rows = buildRows(member);
  computeFusable();
  renderAll(profile);

  loadRecipes().then(() => {
    if (!state.rows.length) return;
    computeFusable();
    renderTabs();
    renderGrid();
  });
}

async function lookup(ev) {
  ev.preventDefault();
  const name = $("username").value.trim();
  const key = $("apikey").value.trim();
  if (!name || !key) return;

  $("go").disabled = true;
  say("Suche den Account ...", "busy");

  try {
    const who = await resolveUuid(name);
    state.uuid = who.uuid;
    state.playerName = who.name;

    say("Hole die SkyBlock-Profile ...", "busy");
    const profiles = await fetchProfiles(who.uuid, key);
    if (!profiles.length) {
      say("Keine SkyBlock-Profile gefunden. Steht der Account auf einem anderen Namen?", "err");
      return;
    }

    state.profiles = profiles;
    const selected = profiles.findIndex((p) => p.selected);
    const idx = selected >= 0 ? selected : 0;

    if ($("remember").checked) store.set("hb_key", key); else store.del("hb_key");
    store.set("hb_name", who.name);

    say("");
    $("results").hidden = false;
    showProfile(idx);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    say(explain(err), "err");
  } finally {
    $("go").disabled = false;
  }
}

function explain(err) {
  if (err.message === "nouser" || err.status === 404) {
    return "Den Namen kennt Mojang nicht. Tippfehler?";
  }
  if (err.status === 403 || /key/i.test(err.message || "")) {
    return "Der API-Key wird abgelehnt. Neu erzeugen auf developer.hypixel.net.";
  }
  if (err.status === 429) {
    return "Zu viele Anfragen mit diesem Key. Kurz warten und nochmal.";
  }
  if (err instanceof TypeError) {
    return "Die Hypixel-API war nicht erreichbar. Blockiert vielleicht ein Adblocker die Anfrage?";
  }
  return "Hat nicht geklappt: " + (err.message || "unbekannter Fehler");
}

/* ---------- Start ---------- */

(async function init() {
  try {
    state.db = await getJSON("shards.json?v=" + VERSION);
  } catch {
    say("shards.json laesst sich nicht laden. Liegt die Datei neben der index.html?", "err");
    return;
  }
  // Erst die alten Schreibweisen eintragen, dann die echten IDs drueberlegen.
  // Wichtig, weil eine Alt-ID die echte ID eines anderen Shards sein kann:
  // "humanoid_ruler" ist heute Drowned, war frueher Wetwing.
  for (const [id, info] of Object.entries(state.db)) {
    for (const alias of info.attribute_aliases || []) {
      state.byAttrId.set(String(alias).toLowerCase(), id);
    }
    if (info.shard_id) state.shardIdIndex.set(info.shard_id, id);
  }
  for (const [id, info] of Object.entries(state.db)) {
    if (info.attribute_id) state.byAttrId.set(String(info.attribute_id).toLowerCase(), id);
  }
  $("dbCount").textContent = Object.keys(state.db).length;

  const families = new Set();
  for (const info of Object.values(state.db)) {
    (info.family || []).forEach((f) => families.add(f));
  }
  const famSel = $("fFamily");
  [...families].sort((a, b) => a.localeCompare(b)).forEach((f) => {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = f;
    famSel.appendChild(o);
  });

  probeSkins();
  fillShowcase();

  const savedName = store.get("hb_name");
  const savedKey = store.get("hb_key");
  if (savedName) $("username").value = savedName;
  if (savedKey) $("apikey").value = savedKey;

  setMode(store.get("hb_view") || "box");
  document.querySelector(".viewswitch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) setMode(b.dataset.mode);
  });

  $("grid").addEventListener("pointermove", onGridPointer);
  $("grid").addEventListener("pointerleave", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });

  $("lookup").addEventListener("submit", lookup);
  $("csv").addEventListener("click", downloadCSV);
  $("profileSelect").addEventListener("change", (e) => showProfile(Number(e.target.value)));

  $("ready").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (!b) return;
    state.view = b.dataset.goto;
    renderTabs();
    renderGrid();
    $("tabs").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    state.view = btn.dataset.view;
    renderTabs();
    renderGrid();
  });

  ["search", "fRarity", "fCategory", "fFamily", "fSource", "fSort"].forEach((id) =>
    $(id).addEventListener("input", renderGrid));

  // Familien-Tag filtert, Klick auf die Karte oeffnet die Details
  $("grid").addEventListener("click", (e) => {
    const tag = e.target.closest(".tag.fam");
    if (tag) {
      const sel = $("fFamily");
      sel.value = sel.value === tag.dataset.family ? "" : tag.dataset.family;
      renderGrid();
      return;
    }
    const card = e.target.closest(".card, .islot");
    if (card) { hideTip(); openDetail(card.dataset.id); }
  });

  $("grid").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".card");
    if (!card || e.target.closest(".tag.fam")) return;
    e.preventDefault();
    openDetail(card.dataset.id);
  });

  // Im Dialog: Klick auf einen Kandidaten springt zu dessen Details
  $("detailBody").addEventListener("click", (e) => {
    const pick = e.target.closest(".pick, .ing");
    if (pick) { openDetail(pick.dataset.open); return; }
  });
  $("detailBody").addEventListener("change", (e) => {
    if (e.target.id === "ownedOnly") {
      state.detailOwnedOnly = e.target.checked;
      openDetail(state.detailId);
    }
    if (e.target.id === "readyOnly") {
      state.detailReadyOnly = e.target.checked;
      openDetail(state.detailId);
    }
  });
  $("detailClose").addEventListener("click", () => $("detail").close());
  $("detail").addEventListener("click", (e) => {
    if (e.target === $("detail")) $("detail").close();   // Klick auf den Hintergrund
  });
})();

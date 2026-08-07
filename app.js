/* Hunting Box - Shard-Tracker
   Laeuft komplett im Browser. Der API-Key geht nur an api.hypixel.net. */

"use strict";

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

  const stacks = (member.attributes && member.attributes.stacks) || {};
  for (const [k, v] of Object.entries(stacks)) {
    const id = resolveShardId(k);
    if (id) syphoned.set(id, (syphoned.get(id) || 0) + (Number(v) || 0));
  }

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

  for (const [id, info] of Object.entries(state.db)) {
    const count = syphoned.has(id) ? syphoned.get(id) : null;
    const lv = levelOf(count || 0, info.rarity);
    if (count !== null) {
      unlocked++;
      toMax += lv.remaining;
      if (lv.remaining === 0) maxed++;
    }
    rows.push({
      id, info,
      count,
      box: inBox.get(id) || 0,
      unlocked: count !== null,
      ...lv,
    });
  }

  state.rowById = new Map(rows.map((r) => [r.id, r]));

  state.totals = {
    total: rows.length,
    unlocked,
    maxed,
    inProgress: unlocked - maxed,
    missing: rows.length - unlocked,
    toMax,
    readyToSyphon: rows.filter((r) => !r.unlocked && r.box > 0).length,
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

  const ready = $("ready");
  ready.hidden = t.readyToSyphon === 0;
  if (t.readyToSyphon) {
    ready.textContent = t.readyToSyphon === 1
      ? "1 Shard liegt in deiner Hunting Box und ist noch nicht syphont."
      : `${t.readyToSyphon} Shards liegen in deiner Hunting Box und sind noch nicht syphont.`;
  }

  const pMax = (t.maxed / t.total) * 100;
  const pPart = (t.inProgress / t.total) * 100;
  $("meter").innerHTML =
    `<span class="m-max" style="width:${pMax}%"></span><span class="m-part" style="width:${pPart}%"></span>`;
}

function renderTabs() {
  const t = state.totals;
  const defs = [
    ["progress", "Angefangen", t.inProgress],
    ["missing", "Nie syphont", t.missing],
    ["maxed", "Fertig", t.maxed],
    ["all", "Alle", t.total],
  ];
  $("tabs").innerHTML = defs.map(([key, label, n]) =>
    `<button class="tab" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}<b>${n}</b></button>`
  ).join("");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function cardHTML(row) {
  const i = row.info;
  const rc = "r-" + i.rarity;
  const direct = i.direct_methods || [];
  const rules = i.fusion_rules || [];
  const examples = i.fusion_examples || [];

  const pips = Array.from({ length: 10 }, (_, n) =>
    `<span class="pip${n < row.level ? " on" : ""}"></span>`).join("");

  const levelBlock = row.unlocked
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

  const tags = [];
  if (row.box > 0) tags.push(`<span class="tag box">${row.box}x in der Box</span>`);
  if (!direct.length) tags.push('<span class="tag fusion-only">nur Fusion</span>');
  tags.push(`<span class="tag">${esc(i.category)}</span>`);
  if (i.type) tags.push(`<span class="tag">${esc(i.type)}</span>`);
  (i.family || []).forEach((f) => tags.push(
    `<button type="button" class="tag fam" data-family="${esc(f)}" aria-pressed="false" title="Nach dieser Familie filtern">${esc(f)}</button>`));

  return `<article class="card" data-id="${esc(row.id)}" tabindex="0" role="button" aria-label="${esc(i.name)} Shard - Details">
    <div class="card-top ${rc}">
      <span class="shard-mark"></span>
      <h3>${esc(i.name)}</h3>
      <span class="rar">${esc(i.rarity)}</span>
    </div>
    <p class="attr">${esc(i.attribute || "")}</p>
    <p class="effect">${esc(i.effect || "")}</p>
    ${levelBlock}
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
  else if (state.view === "progress") rows.sort((a, b) => b.level - a.level || a.remaining - b.remaining);
  else if (state.view === "missing") rows.sort((a, b) =>
    (b.box > 0) - (a.box > 0) ||
    ((a.info.direct_methods || []).length === 0) - ((b.info.direct_methods || []).length === 0) ||
    RARITIES.indexOf(a.info.rarity) - RARITIES.indexOf(b.info.rarity) || byName(a, b));
  else rows.sort(byName);

  return rows;
}

function renderGrid() {
  const rows = visibleRows();
  $("grid").innerHTML = rows.map(cardHTML).join("");
  const active = $("fFamily").value;
  if (active) {
    $("grid").querySelectorAll(`.tag.fam[data-family="${CSS.escape(active)}"]`)
      .forEach((el) => el.setAttribute("aria-pressed", "true"));
  }
  $("empty").hidden = rows.length > 0;
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
      return (info.family || []).includes(a);
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
    state.recipes = await getJSON("recipes.json");
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
    return { a: ra, b: rb, qty: qty || 1, ready: ra.box > 0 && rb.box > 0, half: (ra.box > 0) !== (rb.box > 0) };
  }).filter(Boolean).sort((x, y) =>
    y.ready - x.ready ||
    y.half - x.half ||
    (RARITIES.indexOf(x.a.info.rarity) + RARITIES.indexOf(x.b.info.rarity)) -
    (RARITIES.indexOf(y.a.info.rarity) + RARITIES.indexOf(y.b.info.rarity)) ||
    x.a.info.name.localeCompare(y.a.info.name));
}

function ingredientHTML(r) {
  const st = r.box > 0 ? `<span class="ing-box">${r.box}x</span>` : "";
  return `<button type="button" class="ing r-${r.info.rarity}" data-open="${esc(r.id)}">${esc(r.info.name)}${st}</button>`;
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
      <span>Nur Kombis, fuer die ich beide Zutaten in der Box habe</span></label>
    <p class="d-none">${onlyReady ? `${list.length} von ${total}` : `${total} Kombis`}${
      list.length > CAP ? ` &middot; zeigt die ersten ${CAP}` : ""}</p>
    ${items ? `<ul class="combo-list">${items}</ul>`
            : '<p class="d-none">Keine Kombi, bei der beide Zutaten schon in deiner Box liegen.</p>'}
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

  const status = row.unlocked
    ? `Level ${ROMAN[row.level]} &middot; ${row.count}/${row.max} Shards${row.remaining ? ` &middot; noch ${row.remaining}` : " &middot; fertig"}`
    : "Noch nie syphont";

  const parts = [`
    <div class="d-head ${rc}">
      <span class="shard-mark"></span>
      <h2>${esc(i.name)} Shard</h2>
      <span class="rar">${esc(i.rarity)}</span>
    </div>
    <p class="d-attr">${esc(i.attribute || "")}</p>
    <p class="d-effect">${esc(i.effect || "")}</p>
    <p class="d-effect">${status}${row.box ? ` &middot; <span style="color:var(--good)">${row.box}x in der Box</span>` : ""}</p>`];

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
      r.unlocked ? r.remaining : r.max, r.box,
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
  renderAll(profile);
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
    state.db = await getJSON("shards.json");
  } catch {
    say("shards.json laesst sich nicht laden. Liegt die Datei neben der index.html?", "err");
    return;
  }
  for (const [id, info] of Object.entries(state.db)) {
    if (info.attribute_id) state.byAttrId.set(String(info.attribute_id).toLowerCase(), id);
    if (info.shard_id) state.shardIdIndex.set(info.shard_id, id);
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

  const savedName = store.get("hb_name");
  const savedKey = store.get("hb_key");
  if (savedName) $("username").value = savedName;
  if (savedKey) $("apikey").value = savedKey;

  $("lookup").addEventListener("submit", lookup);
  $("csv").addEventListener("click", downloadCSV);
  $("profileSelect").addEventListener("change", (e) => showProfile(Number(e.target.value)));

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
    const card = e.target.closest(".card");
    if (card) openDetail(card.dataset.id);
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

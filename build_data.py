#!/usr/bin/env python3
"""
build_data.py - Baut shards.json (alle Shards inkl. Beschaffungswegen).

Quellen (Open Source, werden live von GitHub geladen):
  - SkyShards (Campionnn/SkyShards):
      fusion-properties.json  Rarity, Kategorie, Familie
      fusion-data.json        konkrete Fusions-Rezepte, Shard-Bereich, API-ID
      desc.json               Attributname, Effekt UND die In-Game-Zeilen
                              "How to obtain" (Basis fuer Direkt/Fusion)
  - NEU-Repo (NotEnoughUpdates):
      constants/attribute_shards.json   echte interne Attribut-IDs
      items/ATTRIBUTE_SHARD_*.json      Kopf-Textur jedes Shards (SkullOwner)

Einmal ausfuehren, dann liegt shards.json neben dem Tracker.
Nach einem Skyblock-Update einfach erneut ausfuehren.
"""

import base64
import json
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SKYSHARDS = "https://raw.githubusercontent.com/Campionnn/SkyShards/master"
NEU = "https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master"

RARITY_ORDER = ["Common", "Uncommon", "Rare", "Epic", "Legendary"]
MAX_EXAMPLES = 3


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "shard-tracker-build"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


SKULL_VALUE = re.compile(r'Value:"([^"]+)"')
TEXTURE_HASH = re.compile(r"/texture/([0-9a-f]{20,})")


def skin_hash(internal_name):
    """Textur-Hash des Spielerkopfs, den das Spiel fuer diesen Shard zeigt.

    Steckt im SkullOwner-NBT des Items als base64-JSON:
    {"textures":{"SKIN":{"url":"http://textures.minecraft.net/texture/<hash>"}}}
    Die Seite laedt das Bild spaeter direkt von textures.minecraft.net.
    """
    url = f"{NEU}/items/{urllib.parse.quote(internal_name)}.json"
    try:
        item = fetch_json(url)
    except Exception:
        return None
    m = SKULL_VALUE.search(item.get("nbttag", ""))
    if not m:
        return None   # kein Kopf, sondern ein Block-Item (Sea Lantern, Packed Ice, ...)
    raw = m.group(1)
    try:
        decoded = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "replace")
    except Exception:
        return None
    h = TEXTURE_HASH.search(decoded)
    return h.group(1) if h else None


def flatten(nodes):
    """Minecraft-Textbausteine ({t:..}, {range:[a,b]}) zu Klartext."""
    out = []
    for n in nodes or []:
        if "t" in n:
            out.append(n["t"])
        elif "range" in n:
            lo, hi = n["range"]
            out.append(f"{lo}-{hi}{n.get('unit', '')}")
    # Private-Use-Zeichen (Minecraft-Icons) rauswerfen
    return "".join(c for c in "".join(out) if not ("\ue000" <= c <= "\uf8ff"))


# Die Quelle liefert vereinzelt kaputte Zeilen mit Farbcode-Resten
# (z.B. bei Rainbug: "lIlIlIlIlIlIlI%gray%% Critter Safari."). Den Muell
# vorne abschneiden und den lesbaren Rest behalten.
BROKEN = re.compile(r"^.*%+\s*|^lIlI[lI]*\s*")


def clean_line(line):
    txt = " ".join(flatten(line).replace("-", "-").split()).lstrip("- ").strip()
    if BROKEN.search(txt):
        txt = BROKEN.sub("", txt).strip()
    return txt if len(txt) >= 6 else ""


def main():
    print("Lade SkyShards-Daten ...")
    props = fetch_json(f"{SKYSHARDS}/public/fusion-properties.json")
    fusion = fetch_json(f"{SKYSHARDS}/public/fusion-data.json")   # ~2 MB
    desc = fetch_json(f"{SKYSHARDS}/src/desc.json")
    print("Lade NEU-Konstanten (echte Attribut-IDs) ...")
    neu = fetch_json(f"{NEU}/constants/attribute_shards.json")
    print(f"  {len(props)} Shards gefunden")

    # Die Hypixel-API schluesselt attributes.stacks nach der INTERNEN Attribut-ID,
    # nicht nach dem Anzeigenamen. Bei umbenannten Attributen faellt das auseinander:
    # Drowned heisst intern humanoid_ruler, obwohl das Attribut "Undead Fortune" ist.
    # Darum die ID aus dem Item-Namen im NEU-Repo ziehen, den desc-Slug nur als Alias.
    real_id = {}
    internal_by_sid = {}
    for e in neu.get("attributes", []):
        internal = e.get("internalName", "")
        if internal.startswith("ATTRIBUTE_SHARD_"):
            real_id[e["shardId"]] = internal.replace("ATTRIBUTE_SHARD_", "").split(";")[0].lower()
            internal_by_sid[e["shardId"]] = internal

    print(f"Lade Kopf-Texturen fuer {len(internal_by_sid)} Shards ...")
    with ThreadPoolExecutor(max_workers=12) as pool:
        sids = list(internal_by_sid)
        skins = dict(zip(sids, pool.map(lambda s: skin_hash(internal_by_sid[s]), sids)))

    fd_shards = fusion["shards"]
    recipes = fusion.get("recipes", {})

    # Erst Grunddaten, dann Rezepte (die brauchen die Grunddaten aller Shards)
    base = {}
    for sid, p in props.items():
        fd = fd_shards.get(sid, {})
        d = desc.get(sid, {})

        lines = [clean_line(l) for l in d.get("how_to_hunt", [])]
        lines = [l for l in lines if l]
        fusion_rules = [l for l in lines if l.lower().startswith("fusing")]
        direct = [l for l in lines if not l.lower().startswith("fusing")]

        base[sid] = {
            "shard_id": sid,
            "name": p.get("name") or fd.get("name"),
            "api_id": fd.get("internal_id"),
            "attribute": d.get("title"),
            "attribute_id": real_id.get(sid) or d.get("id"),
            "attribute_aliases": sorted({x for x in (d.get("id"), real_id.get(sid)) if x}
                                        - {real_id.get(sid) or d.get("id")}),
            "effect": " ".join(flatten(d.get("description")).split()),
            "rarity": (p.get("rarity") or fd.get("rarity") or "").capitalize(),
            "skin": skins.get(sid),                  # textures.minecraft.net/texture/<skin>
            "category": p.get("category"),           # Forest / Water / Combat
            "type": fd.get("type"),                  # Bereich: Foraging, Fishing, ...
            "family": p.get("family") or [],
            "fuse_amount": fd.get("fuse_amount"),
            "direct_methods": direct,                # leer = nur ueber Fusion
            "obtainable_directly": bool(direct),
            "fusion_rules": fusion_rules,
            # Maschinenlesbare Regel: "Forest&Common" + "Uncommon+"
            # & = und, | = oder, "X+" = X oder hoeher, "X Shard" = genau dieser Shard
            "fuse_inputs": [p.get("input1") or "", p.get("input2") or ""],
            "fusion_examples": [],
        }

    # Konkrete Fusions-Rezepte: die praktischsten zuerst
    # (Zutaten die man selbst jagen kann > alles andere, dann niedrige Rarity)
    def rank(pair_and_qty):
        (a, b), qty = pair_and_qty
        ia, ib = base.get(a), base.get(b)
        if not ia or not ib:
            return (9, 9, 9)
        direct_score = -(int(ia["obtainable_directly"]) + int(ib["obtainable_directly"]))
        rarity_score = sum(
            RARITY_ORDER.index(i["rarity"]) if i["rarity"] in RARITY_ORDER else 5
            for i in (ia, ib)
        )
        return (direct_score, rarity_score, -qty)

    for sid, info in base.items():
        cands = []
        seen = set()
        for qty, pairs in (recipes.get(sid) or {}).items():
            for a, b in pairs:
                key = tuple(sorted((a, b)))
                if key in seen:
                    continue
                seen.add(key)
                cands.append(((a, b), int(qty)))
        cands.sort(key=rank)

        for (a, b), qty in cands[:MAX_EXAMPLES]:
            ia, ib = base.get(a), base.get(b)
            if not ia or not ib:
                continue
            def label(i):
                return f"{i['name']} ({i['rarity']}, {i['category']})"
            txt = f"{label(ia)} + {label(ib)}"
            if qty > 1:
                txt += f" = {qty}x"
            info["fusion_examples"].append(txt)

    out = {info["api_id"]: info for info in base.values() if info.get("api_id")}

    with open("shards.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # Shards ohne allgemeine Regel: dort sind die konkreten Kombis die einzige
    # Auskunft. Kommen in eine eigene Datei, die die Seite erst beim ersten
    # Detail-Klick nachlaedt (~170 KB gezippt).
    combos = {}
    for api, info in out.items():
        if info["fuse_inputs"][0]:
            continue                      # hat eine Regel, laesst sich berechnen
        seen, pairs = set(), []
        for qty, pl in (recipes.get(info["shard_id"]) or {}).items():
            for a, b in pl:
                key = tuple(sorted((a, b))) + (qty,)
                if key in seen:
                    continue
                seen.add(key)
                pairs.append([a, b, int(qty)] if int(qty) > 1 else [a, b])
        if pairs:
            combos[api] = pairs

    with open("recipes.json", "w", encoding="utf-8") as f:
        json.dump(combos, f, separators=(",", ":"))

    renamed = sum(1 for i in out.values() if i["attribute_aliases"])
    no_skin = [i["name"] for i in out.values() if not i["skin"]]
    print(f"Koepfe: {len(out) - len(no_skin)}/{len(out)}"
          + (f" (ohne: {', '.join(no_skin[:8])})" if no_skin else ""))
    direct = sum(1 for i in out.values() if i["obtainable_directly"])
    print(f"OK: {len(out)} Shards -> shards.json ({renamed} mit abweichender Alt-ID)")
    print(f"     davon {direct} direkt erhaeltlich, {len(out) - direct} nur durch Fusion")
    print(f"OK: Kombis fuer {len(combos)} Shards ohne Regel -> recipes.json")


if __name__ == "__main__":
    main()

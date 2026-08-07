#!/usr/bin/env python3
"""
build_data.py - Baut shards.json (alle Shards inkl. Beschaffungswegen).

Quellen (Open Source, werden live von GitHub geladen):
  - SkyShards (Campionnn/SkyShards):
      fusion-properties.json  Rarity, Kategorie, Familie
      fusion-data.json        konkrete Fusions-Rezepte, Shard-Bereich, API-ID
      desc.json               Attributname, Effekt UND die In-Game-Zeilen
                              "How to obtain" (Basis fuer Direkt/Fusion)
  - NEU-Repo: nur noch als Fallback fuer API-IDs

Einmal ausfuehren, dann liegt shards.json neben dem Tracker.
Nach einem Skyblock-Update einfach erneut ausfuehren.
"""

import json
import urllib.request

SKYSHARDS = "https://raw.githubusercontent.com/Campionnn/SkyShards/master"

RARITY_ORDER = ["Common", "Uncommon", "Rare", "Epic", "Legendary"]
MAX_EXAMPLES = 3


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "shard-tracker-build"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


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


def clean_line(line):
    return " ".join(flatten(line).replace("-", "-").split()).lstrip("- ").strip()


def main():
    print("Lade SkyShards-Daten ...")
    props = fetch_json(f"{SKYSHARDS}/public/fusion-properties.json")
    fusion = fetch_json(f"{SKYSHARDS}/public/fusion-data.json")   # ~2 MB
    desc = fetch_json(f"{SKYSHARDS}/src/desc.json")
    print(f"  {len(props)} Shards gefunden")

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
            "attribute_id": d.get("id"),
            "effect": " ".join(flatten(d.get("description")).split()),
            "rarity": (p.get("rarity") or fd.get("rarity") or "").capitalize(),
            "category": p.get("category"),           # Forest / Water / Combat
            "type": fd.get("type"),                  # Bereich: Foraging, Fishing, ...
            "family": p.get("family") or [],
            "fuse_amount": fd.get("fuse_amount"),
            "direct_methods": direct,                # leer = nur ueber Fusion
            "obtainable_directly": bool(direct),
            "fusion_rules": fusion_rules,
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

    direct = sum(1 for i in out.values() if i["obtainable_directly"])
    print(f"OK: {len(out)} Shards -> shards.json")
    print(f"     davon {direct} direkt erhaeltlich, {len(out) - direct} nur durch Fusion")


if __name__ == "__main__":
    main()

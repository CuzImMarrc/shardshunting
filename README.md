# Hunting Box

Zeigt für ein Hypixel-SkyBlock-Profil, welche Attribut-Shards noch fehlen, auf welchem Level die
angefangenen stehen und wie man sie bekommt — direkt jagdbar oder nur über die Fusion.

Läuft komplett im Browser. Kein Server, keine Datenbank, kein Tracking. Jeder Besucher benutzt
seinen eigenen Hypixel-API-Key; der bleibt im Browser und geht ausschließlich an `api.hypixel.net`.

## Online stellen (GitHub Pages)

1. Neues öffentliches Repository anlegen.
2. Diese Dateien ins Repo-Root laden: `index.html`, `style.css`, `app.js`, `shards.json`,
   `recipes.json`.
3. **Settings → Pages → Source: Deploy from a branch**, Branch `main`, Ordner `/ (root)`, speichern.
4. Nach ein paar Minuten liegt die Seite unter `https://<dein-name>.github.io/<repo>/`.

## Lokal testen

`index.html` per Doppelklick zu öffnen funktioniert **nicht** — Browser blockieren bei `file://`
das Nachladen von `shards.json`. Stattdessen im Projektordner einen Mini-Server starten:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 aufrufen
```

## Was der Besucher braucht

Einen API-Key von [developer.hypixel.net](https://developer.hypixel.net/dashboard) und im Spiel
freigegebene API-Einstellungen. Ohne Freigabe liefert Hypixel leere Profildaten.

## Daten aktualisieren

`shards.json` enthält alle Shards mit Rarity, Kategorie, Familie, Attribut, den In-Game-Zeilen
„How to obtain" und konkreten Fusions-Kombis. Nach einem SkyBlock-Update neu erzeugen:

```bash
python3 build_data.py
```

Das Skript zieht die Daten aus dem offenen
[SkyShards-Datensatz](https://github.com/Campionnn/SkyShards) und schreibt `shards.json` neu.
Sonst muss nichts angefasst werden.

## Fusions-Ansicht

Ein Klick auf eine Shard-Karte öffnet die Detailansicht. Hat der Shard eine Fusions-Regel, listet
sie für Slot 1 und Slot 2 alle Shards auf, die dort tatsächlich hineinpassen — mit dem Hinweis, was
davon schon in der eigenen Hunting Box liegt. Ein Klick auf einen Kandidaten springt zu dessen
Details, so lässt sich eine Fusionskette rückwärts verfolgen.

Nur 98 der 321 Shards haben eine solche allgemeine Regel. Die übrigen entstehen aus festen
Kombinationen — die stehen in `recipes.json` und werden erst beim ersten Klick auf eine Karte
nachgeladen (~165 KB gzip). Für diese Shards zeigt die Detailansicht statt der Slots die komplette
Kombiliste, mit Filter auf das, was man sofort fusen kann.

Die Regeln stehen maschinenlesbar in `shards.json` unter `fuse_inputs`, z.B.
`["Forest&Legendary", "Elemental&Epic+"]`. Die Syntax: `&` = und, `|` = oder, `X+` = X oder höher,
`Name Shard` = genau dieser Shard, `Mining Shards` = Attribut-Bereich Mining. Ausgewertet wird das
in `app.js` in `matchesRule()`.

## Wie die Level berechnet werden

Die API liefert unter `attributes.stacks` die Gesamtzahl syphonter Shards pro Attribut. Wie viele
davon eine Stufe kostet, hängt an der Rarity — Common braucht 96 Shards bis Level 10, Legendary
nur 24. Die Tabelle steht in `app.js` unter `LEVEL_COSTS`.

## Grenzen

- Die Fusions-Beispiele sind Kombis aus dem SkyShards-Datensatz, bevorzugt aus Zutaten, die man
  selbst jagen kann. Sie sind nicht auf Kosten optimiert — das Ziel war Ironman-Tauglichkeit.
- „Attribut-Bereich" (Foraging, Fishing, …) sagt, wofür das Attribut gut ist, nicht wo der Shard
  herkommt. Wo er herkommt, steht in der Zeile „So bekommst du ihn".
- Nicht mit Hypixel affiliiert.

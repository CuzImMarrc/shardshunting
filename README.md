# Hunting Box

Zeigt für ein Hypixel-SkyBlock-Profil, welche Attribut-Shards noch fehlen, auf welchem Level die
angefangenen stehen und wie man sie bekommt — direkt jagdbar oder nur über die Fusion.

Läuft komplett im Browser. Kein Server, keine Datenbank, kein Tracking. Jeder Besucher benutzt
seinen eigenen Hypixel-API-Key; der bleibt im Browser und geht ausschließlich an `api.hypixel.net`.

## Online stellen (GitHub Pages)

1. Neues öffentliches Repository anlegen.
2. Diese Dateien ins Repo-Root laden: `index.html`, `style.css`, `app.js`, `shards.json`,
   `recipes.json` und den Ordner `icons/`.
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
[SkyShards-Datensatz](https://github.com/Campionnn/SkyShards) und dem
[NEU-Repo](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO) und schreibt `shards.json`
und `recipes.json` neu. Sonst muss nichts angefasst werden.

## Köpfe

Jeder Shard wird im Spiel als Spielerkopf dargestellt. `build_data.py` liest dafür aus den
NEU-Item-Dateien (`items/ATTRIBUTE_SHARD_*.json`) die Kopf-Textur und speichert ihren Hash als
`skin` in `shards.json`. Die Seite lädt das Bild dann direkt von
`https://textures.minecraft.net/texture/<skin>` und baut daraus mit CSS einen 3D-Würfel wie im
Inventar (Oberseite, Gesicht, Seite, plus Hut-Layer). Als CSS-Hintergrund braucht das kein CORS.

Sieben Shards sind im Spiel keine Spielerköpfe mit eigener Textur, sondern Vanilla-Mobköpfe oder
Blöcke. Für die gilt:

- **Lapis Zombie, Miner Zombie, Zombie Soldier, Wither**: Hypixels eigener Kopf des gleichnamigen
  Mobs aus dem Bestiary (`constants/bestiary.json` im NEU-Repo; beim Wither-Shard der Wither
  Skeleton).
- **Glacite Walker, Obsidian Defender, Flora**: Dafür gibt es nirgends eine Kopf-Textur, auch
  Hypixels Bestiary zeigt hier Packed Ice bzw. Obsidian. Diese drei kommen als eigene Pixel-Icons
  aus dem Ordner `icons/` (zwei Block-Texturen als Würfel, die Sonnenblume flach). Die Zuordnung
  steht in `build_data.py` unter `LOCAL_ICONS`.

Ist `textures.minecraft.net` nicht erreichbar (Firmennetz, Adblocker), prüft die Seite das beim
Laden einmal und zeigt statt der Köpfe Kristalle in Rarity-Farbe.

## Ansichten

- **Box** (Standard): Raster aus Inventar-Slots, gruppiert nach Forest / Water / Combat.
  Die Zahl im Slot ist das Level, der Balken darunter der Fortschritt bis Level 10 (wie die
  Haltbarkeit eines Werkzeugs), gold = gemaxt, grüner Punkt = liegt in der Hunting Box,
  grau = noch nie syphont. Beim Drüberfahren erscheint ein Tooltip wie im Spiel.
- **Karten**: die ausführliche Ansicht mit Beschaffung und Kombis direkt auf der Karte.

Die gewählte Ansicht merkt sich der Browser.

## Fusions-Ansicht

Ein Klick auf eine Shard-Karte öffnet die Detailansicht. Hat der Shard eine Fusions-Regel, listet
sie für Slot 1 und Slot 2 alle Shards auf, die dort tatsächlich hineinpassen — mit dem Hinweis, was
davon schon in der eigenen Hunting Box liegt. Ein Klick auf einen Kandidaten springt zu dessen
Details, so lässt sich eine Fusionskette rückwärts verfolgen.

Nur rund 100 der 325 Shards haben eine solche allgemeine Regel. Die übrigen entstehen aus festen
Kombinationen — die stehen in `recipes.json` und werden erst beim ersten Klick auf eine Karte
nachgeladen (~165 KB gzip). Für diese Shards zeigt die Detailansicht statt der Slots die komplette
Kombiliste, mit Filter auf das, was man sofort fusen kann.

Die Regeln stehen maschinenlesbar in `shards.json` unter `fuse_inputs`, z.B.
`["Forest&Legendary", "Elemental&Epic+"]`. Die Syntax: `&` = und, `|` = oder, `X+` = X oder höher,
`Name Shard` = genau dieser Shard, `Mining` oder `Mining Shards` = Attribut-Bereich Mining (die
Quelle schreibt das mal so, mal so). Ausgewertet wird das in `app.js` in `matchesRule()`.

## „Jetzt fusebar"

Der erste Tab zeigt alle Shards, die sich mit dem aktuellen Inhalt der Hunting Box sofort fusen
lassen. Pro Zutat wird deren `fuse_amount` verbraucht (2 oder 5 Stück, steht in `shards.json`);
zweimal derselbe Shard braucht entsprechend die doppelte Menge. Der Tab lädt `recipes.json` im
Hintergrund und zeigt so lange `…` als Zahl.

## Attribut-IDs

Die Hypixel-API schlüsselt `attributes.stacks` nach der **internen** Attribut-ID, nicht nach dem
Anzeigenamen. Bei umbenannten Attributen fällt das auseinander: Drowned zeigt „Undead Fortune",
heißt intern aber `humanoid_ruler` — und `humanoid_ruler` war früher Wetwing. `build_data.py` zieht
die echte ID deshalb aus dem NEU-Repo (`internalName`) und legt den alten Namens-Slug als
`attribute_aliases` daneben. Beim Aufbau der Zuordnung werden erst die Aliase eingetragen und dann
die echten IDs darübergelegt, damit bei solchen Überschneidungen die aktuelle Bedeutung gewinnt.

Attribute, die zu keinem Shard passen, werden nicht mehr stillschweigend verworfen, sondern über
der Tab-Leiste angezeigt — so fallen künftige Umbenennungen sofort auf.

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

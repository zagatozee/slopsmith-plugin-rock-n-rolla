# Rock 'n' Rolla — Slopsmith Plugin

A Donkey Kong–style guitarcade mini-game for [Slopsmith](https://github.com/byrongamatos/slopsmith).

Barrels roll down the screen, each labelled with a chord name. Strum that chord before the barrel hits the floor!

## Install

Open Slopsmith → **Plugins → Plugin Manager**, paste the GitHub URL and click **Install**:

```
https://github.com/zagatozee/slopsmith-plugin-rock-n-rolla
```

Restart Slopsmith. Rock 'n' Rolla will appear under **Plugins** and in the **Minigames** hub.

### Bundled demo songs

Any Rocksmith 2014 arrangement XML placed in the plugin's `content/` folder is auto-detected as a built-in source. A small set of demo arrangements ships in that folder — select them from the **SOURCE** dropdown when you open the plugin.

## How to play

1. **Load chords** — pick a built-in source from the **SOURCE** dropdown, or click **📂 XML FILE** to upload a Rocksmith 2014 arrangement XML directly.
2. **Toggle active chords** in the sidebar — unchecked chords won't appear as barrels.
3. Click **▶ START**.
4. Strum the chord shown on each barrel before it hits the floor.  
   Miss = life lost. Three misses and it's game over.

## With the Note Detection plugin

Enable the [slopsmith-plugin-notedetect](https://github.com/byrongamatos/slopsmith-plugin-notedetect) plugin first, then:

1. Click **🎙 DETECT** in Rock 'n' Rolla to arm it.
2. Play your guitar — when the note-detect plugin fires a `notedetect:judgment` event with verdict `HIT`/`CLEAN` for a chord, Rock 'n' Rolla automatically matches it against the falling barrels.

## Fallback / Testing without a guitar

Click on a barrel's lane to strum the lowest barrel in that column.

## Chord source format

Any standard Rocksmith 2014 arrangement XML with `<chordTemplates>` is supported — Lead, Rhythm, Bass, or HumStrum. Drop multiple XMLs via repeated **LOAD XML** calls; chords are merged and deduplicated.

The backend route `GET /api/rock_n_rolla/chords` also scans every XML in your DLC folder recursively (works for loose XMLs extracted from PSARCs; for un-extracted PSARCs you'll need to paste the XML manually).

## Scoring

| Event | Points |
|---|---|
| Barrel hit | 100 |
| Combo bonus (per streak count) | +50 |

Level increases every 8 hits, raising spawn rate and fall speed.

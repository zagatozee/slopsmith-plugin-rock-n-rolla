"""
Rock 'n' Rolla backend routes — v0.4
- Serves random arrangement from content/ folder on load
- Exposes ebeat timestamps for frontend metronome scheduling
"""
import xml.etree.ElementTree as ET
import glob
import bisect
import random
from pathlib import Path
from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse

PLUGIN_DIR = Path(__file__).parent


def _parse_arrangement_xml(xml_text: str) -> dict:
    try:
        root = ET.fromstring(xml_text)
    except Exception as e:
        return {"title": "", "artist": "", "chords": [], "queue": [], "ebeats": [], "error": str(e)}

    title  = root.findtext("title",      "")
    artist = root.findtext("artistName", "")

    # ── Ebeats ───────────────────────────────────────────────────────────
    # Return full ebeat list: [{time, is_downbeat}]
    ebeats = []
    ebeats_el = root.find("ebeats")
    if ebeats_el is not None:
        for eb in ebeats_el:
            ebeats.append({
                "time":        float(eb.get("time", "0")),
                "is_downbeat": int(eb.get("measure", "-1")) > 0,
            })

    beat_times = [e["time"] for e in ebeats]

    # ── Chord templates ───────────────────────────────────────────────────
    templates = {}
    template_list = []
    ct_el = root.find("chordTemplates")
    if ct_el is not None:
        for ct in ct_el:
            name = ct.get("chordName", "").strip()
            if not name:
                template_list.append(None)
                continue
            frets   = [int(ct.get(f"fret{i}",   "-1")) for i in range(6)]
            fingers = [int(ct.get(f"finger{i}", "-1")) for i in range(6)]
            entry = {"name": name, "frets": frets, "fingers": fingers}
            templates[name] = entry
            template_list.append(entry)

    # ── Highest-difficulty chord events ───────────────────────────────────
    levels_el = root.find("levels")
    target_level = None
    if levels_el is not None:
        max_diff = -1
        for lv in levels_el:
            d = int(lv.get("difficulty", "0"))
            if d > max_diff:
                max_diff = d
                target_level = lv

    chord_events = []
    if target_level is not None:
        chords_el = target_level.find("chords")
        if chords_el is not None:
            for ch in chords_el:
                ref  = ch.get("refId", "")
                name = ref.split("_")[0] if "_" in ref else ref
                if name not in templates:
                    try:
                        cid = int(ch.get("chordId", "-1"))
                        if 0 <= cid < len(template_list) and template_list[cid]:
                            name = template_list[cid]["name"]
                        else:
                            name = None
                    except Exception:
                        name = None
                if name:
                    chord_events.append({
                        "time": float(ch.get("time", "0")),
                        "name": name,
                    })

    # ── Strum queue (half-measure pulses) ─────────────────────────────────
    song_length = float(root.findtext("songLength", "300"))
    queue = []
    for i, ce in enumerate(chord_events):
        t0 = ce["time"]
        t1 = chord_events[i + 1]["time"] if i + 1 < len(chord_events) else song_length
        idx0 = bisect.bisect_left(beat_times, t0)
        idx1 = bisect.bisect_left(beat_times, t1)
        beat_span  = max(1, idx1 - idx0)
        num_strums = max(1, beat_span // 2)
        for s in range(num_strums):
            queue.append({
                "name":        ce["name"],
                "strum_index": s,
                "num_strums":  num_strums,
                "beat_span":   beat_span,
            })

    return {
        "title":  title,
        "artist": artist,
        "chords": list(templates.values()),
        "queue":  queue,
        "ebeats": ebeats,
    }


def _content_xmls() -> list[Path]:
    content_dir = PLUGIN_DIR / "content"
    if not content_dir.exists():
        return []
    return list(content_dir.glob("*.xml"))


def setup(app, context):
    router = APIRouter()

    @router.get("/api/rock_n_rolla/random")
    async def random_arrangement():
        """Pick a random XML from the content/ folder and parse it."""
        xmls = _content_xmls()
        if not xmls:
            return JSONResponse({"error": "no_content", "chords": [], "queue": [], "ebeats": []})
        chosen = random.choice(xmls)
        xml_text = chosen.read_text(encoding="utf-8", errors="replace")
        data = _parse_arrangement_xml(xml_text)
        data["source_file"] = chosen.name
        return JSONResponse(data)

    @router.get("/api/rock_n_rolla/sources")
    async def list_sources():
        # Built-in content/ XMLs
        sources = []
        for p in sorted(_content_xmls()):
            try:
                root = ET.parse(p).getroot()
                title  = root.findtext("title", "") or p.stem
                artist = root.findtext("artistName", "")
                arr    = root.findtext("arrangement", "")
                label  = f"{artist} — {title} [{arr}]" if artist else f"{title} [{arr}]"
            except Exception:
                label = p.stem
            sources.append({"label": f"[built-in] {label}", "path": str(p)})

        # DLC folder XMLs
        try:
            dlc_dir = context["get_dlc_dir"]()
            for path in sorted(glob.glob(str(dlc_dir / "**" / "*.xml"), recursive=True)):
                try:
                    root = ET.parse(path).getroot()
                    title  = root.findtext("title", "") or Path(path).stem
                    artist = root.findtext("artistName", "")
                    arr    = root.findtext("arrangement", "")
                    label  = f"{artist} — {title} [{arr}]" if artist else f"{title} [{arr}]"
                except Exception:
                    label = Path(path).stem
                sources.append({"label": label, "path": path})
        except Exception:
            pass

        return JSONResponse({"sources": sources})

    @router.get("/api/rock_n_rolla/source")
    async def get_source(path: str):
        try:
            xml_text = Path(path).read_text(encoding="utf-8", errors="replace")
            return JSONResponse(_parse_arrangement_xml(xml_text))
        except Exception as e:
            return JSONResponse({"error": str(e), "chords": [], "queue": [], "ebeats": []})

    @router.post("/api/rock_n_rolla/upload")
    async def upload_xml(file: UploadFile = File(...)):
        try:
            xml_text = (await file.read()).decode("utf-8", errors="replace")
            return JSONResponse(_parse_arrangement_xml(xml_text))
        except Exception as e:
            return JSONResponse({"error": str(e), "chords": [], "queue": [], "ebeats": []})

    @router.post("/api/rock_n_rolla/chords/from_xml")
    async def chords_from_xml_body(body: dict):
        xml_text = body.get("xml", "")
        if not xml_text:
            return JSONResponse({"chords": [], "queue": [], "ebeats": []})
        return JSONResponse(_parse_arrangement_xml(xml_text))

    app.include_router(router)

"""Steamder - a dating app for your Steam library.

Swipe through your games like dating profiles: right = match (you want to play it), left = ghost it, up = super like.
Every game gets a (silly) bio made from what is really known about it: how long you've played, when you got it,
its genres and description from Steam's public store. A "New in town" deck shows games you don't own yet.

No keys or accounts needed. Game details come from Steam's public store pages, one request per card, a few seconds
apart, and are cached, so each game is looked up once.

Only os, re, json, time, asyncio and typing are imported: Decky's bundled Python may lack other standard modules,
and a missing one would stop the whole backend from starting. Web requests use the system `curl`.
"""
import asyncio
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import decky

log = decky.logger

STORE_DETAILS = "https://store.steampowered.com/api/appdetails"
STORE_FEATURED = "https://store.steampowered.com/api/featuredcategories"
STEAM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
STEAM_GAP_S = 1.6                # ~37 requests a minute: under Steam's limit of about 200 per 5 minutes
DETAILS_FRESH_DAYS = 60
MISSING_FRESH_DAYS = 14
STRANGERS_FRESH_S = 6 * 3600
MAX_APPID = 100_000_000
DECK_SIZE = 50
MODES = ("backlog", "flames", "local", "new")
SKIP_NAMES = ("proton", "steam linux runtime", "steamworks common", "steamvr")
DAY = 86400.0


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _curl_env() -> Dict[str, str]:
    """Decky is a PyInstaller app: its library path would break the system curl."""
    env = dict(os.environ)
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig is not None:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    env.pop("LD_PRELOAD", None)
    return env


async def _curl(args: List[str], timeout: int = 25) -> Tuple[int, str, str]:
    """-> (HTTP status or 0, body, error text)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "--silent", "--show-error", "--compressed", "--max-time", str(timeout), "-w", "\n%{http_code}", *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=_curl_env())
        out, err = await asyncio.wait_for(proc.communicate(), timeout + 5)
    except FileNotFoundError:
        return 0, "", "curl isn't installed"
    except asyncio.TimeoutError:
        return 0, "", "the request timed out"
    text = out.decode("utf-8", errors="replace")
    body, _, code = text.rpartition("\n")
    try:
        status = int(code.strip())
    except ValueError:
        status = 0
    return status, body, err.decode("utf-8", errors="replace").strip()[:200]


def rand_float() -> float:
    return int.from_bytes(os.urandom(7), "big") / float(1 << 56)


def shuffled(items: List[Any]) -> List[Any]:
    out = list(items)
    for i in range(len(out) - 1, 0, -1):
        j = int(rand_float() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


def _num(v: Any, lo: float = 0, hi: float = 1e12) -> float:
    try:
        return float(min(hi, max(lo, float(v))))
    except (TypeError, ValueError):
        return 0.0


def clean_desc(text: Any, limit: int = 220) -> str:
    t = re.sub(r"<[^>]+>", " ", str(text or ""))
    for a, b in (("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">")):
        t = t.replace(a, b)
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


def compact_details(raw: Any) -> Optional[Dict[str, Any]]:
    """What is kept of Steam's appdetails answer. None when Steam has no store page for the game."""
    if not isinstance(raw, dict) or not raw.get("success") or not isinstance(raw.get("data"), dict):
        return None
    d = raw["data"]
    m = re.search(r"(19|20)\d\d", str((d.get("release_date") or {}).get("date", "")))
    price = d.get("price_overview") if isinstance(d.get("price_overview"), dict) else {}
    return {"desc": clean_desc(d.get("short_description")),
            "genres": [str(g.get("description")) for g in (d.get("genres") or []) if isinstance(g, dict) and g.get("description")][:5],
            "year": int(m.group(0)) if m else None,
            "meta": int(d["metacritic"]["score"]) if isinstance(d.get("metacritic"), dict) and isinstance(d["metacritic"].get("score"), int) else None,
            "free": bool(d.get("is_free")), "price": str(price.get("final_formatted") or ""), "discount": int(price.get("discount_percent") or 0),
            "img": str(d.get("header_image") or "").split("?")[0][:300],
            "dev": str((d.get("developers") or [""])[0])[:40] if isinstance(d.get("developers"), list) and d.get("developers") else ""}


def parse_featured(data: Any, cc: str = "us") -> List[Dict[str, Any]]:
    """Games from Steam's front-page lists (specials, top sellers, new releases). Odd entries are skipped."""
    out: List[Dict[str, Any]] = []
    seen = set()
    if not isinstance(data, dict):
        return out
    for key in ("new_releases", "top_sellers", "specials"):
        block = data.get(key)
        for it in (block.get("items") if isinstance(block, dict) else None) or []:
            if not isinstance(it, dict) or not isinstance(it.get("id"), int) or it.get("type", 0) not in (0, "app", "game"):
                continue
            if it["id"] in seen or not it.get("name"):
                continue
            seen.add(it["id"])
            final = it.get("final_price") if isinstance(it.get("final_price"), (int, float)) else None
            cur = str(it.get("currency") or "")
            img = str(it.get("header_image") or it.get("large_capsule_image") or "").split("?")[0][:300]
            out.append({"appid": it["id"], "name": str(it["name"])[:100], "source": key, "img": img,
                        "discount": int(it.get("discount_percent") or 0) if it.get("discounted") else 0,
                        "price": (f"{final / 100:.2f} {cur}".strip() if final else "")})
    return out


# ---------------------------------------------------------------------------
# Bios: the joke part. Pure functions, stable per game (the same game always gets the same lines).
# ---------------------------------------------------------------------------
def _pick(options: List[str], appid: int, salt: int = 0) -> str:
    return options[(appid + salt) % len(options)]


def ago(ts: float, now: float) -> str:
    days = max(0.0, (now - ts) / DAY)
    if days < 2:
        return "today" if days < 1 else "yesterday"
    if days < 60:
        return f"{int(days)} days ago"
    if days < 700:
        return f"{int(days // 30)} months ago"
    return f"{int(days // 365)} years ago"


def hours_text(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)} minute{'s' if int(minutes) != 1 else ''}"
    h = minutes / 60.0
    return f"{h:.1f} hours" if h < 10 else f"{int(h)} hours"


CHARACTER = [   # (keyword in description/name/genres, one-liner). The first match wins, so specific ones come first.
    (r"roguelike|roguelite|rogue-like", "Will die for you. Repeatedly."),
    (r"souls-?like|dark souls|elden ring", "Toxic, but you keep coming back."),
    (r"horror|zombie|haunted", "Enjoys long walks in dark corridors."),
    (r"puzzle", "Will make you think about us."),
    (r"farming|farm sim|harvest", "Just wants to settle down and grow something."),
    (r"city[- ]build|colony|management", "Obsessed with the details. Will reorganise your whole life."),
    (r"visual novel", "Talks a lot. You'll love it."),
    (r"platformer|platform game", "Always jumping to conclusions."),
    (r"shooter|fps|first-person shoot", "Quick on the trigger."),
    (r"survival", "Will test your limits."),
    (r"open[- ]world", "Needs a lot of space."),
    (r"co-?op|multiplayer", "Better with friends: this is a double date."),
    (r"racing|driving", "Fast, but won't leave you at the first corner."),
    (r"fighting|beat 'em up", "Has anger issues, but in a fun way."),
    (r"tower defen", "Very protective."),
    (r"card|deckbuild", "Always has something up its sleeve."),
    (r"stealth", "Mysterious. Sneaks around a lot."),
    (r"rpg|role-playing", "Has 400 hours of backstory and will tell you all of it."),
    (r"strategy", "Plans everything. Always 'one more turn'."),
    (r"simulat", "Takes the small things very seriously."),
    (r"adventure", "Takes you places."),
    (r"sports", "Loves a good rivalry."),
    (r"indie", "Not like other games."),
    (r"casual", "Low commitment, no pressure."),
    (r"action", "Fast hands, short temper."),
]


def character_line(name: str, d: Optional[Dict[str, Any]], appid: int) -> str:
    text = " ".join([str(name), str((d or {}).get("desc") or ""), " ".join(str(x) for x in ((d or {}).get("genres") or []))]).lower()
    for pattern, line in CHARACTER:
        if re.search(pattern, text):
            return line
    return _pick(["Hard to describe. Mysterious.", "Says it's 'complicated'.", "Left the bio blank. Classic."], appid)


def relation_line(g: Dict[str, Any], d: Optional[Dict[str, Any]], now: float) -> str:
    """How the game and you are doing, from your playtime."""
    a, minutes = g["appid"], g.get("minutes", 0)
    bought = g.get("purchased") or 0
    since = f"since {time.gmtime(bought).tm_year}" if bought else "for ages"
    if not g.get("owned", True):
        if (d or {}).get("free"):
            return _pick(["Free to play. Easy, but you get what you pay for.", "Costs nothing. Emotionally expensive, though."], a)
        if g.get("discount"):
            return _pick([f"{g['discount']}% off tonight. A cheap date.", f"On sale ({g['discount']}% off). Desperate, or just generous?"], a)
        return _pick(["New in town. Not your type? That's what they all say.", "Everyone's talking about me. Don't be the last to know.", "Just moved here. Looking for someone to play with."], a)
    if minutes <= 0:
        return _pick([f"In your library {since}. Still waiting for you to text back.",
                      f"You got me {since.replace('since', 'in') if bought else 'ages ago'} and never even opened me.",
                      f"You swiped right on me during a sale, then ghosted me ({since}).",
                      f"We've been 'talking' {since}. Zero hours so far."], a)
    last = g.get("last_played") or 0
    if minutes < 60:
        return _pick([f"You spent {hours_text(minutes)} with me and never called back.",
                      f"We had one good session ({hours_text(minutes)}). You said you'd play me again soon.",
                      f"You quit after {hours_text(minutes)}. I'm not mad, just disappointed."], a)
    if last and now - last > 365 * DAY:
        return _pick([f"Last seen {ago(last, now)}. I've changed, I swear.", f"You played me for {hours_text(minutes)}, then vanished {ago(last, now)}. We need to talk."], a)
    if last and now - last > 90 * DAY:
        return _pick([f"{hours_text(minutes)} together, then nothing since {ago(last, now)}. Are we on a break?", f"Your ex, basically ({hours_text(minutes)}, last seen {ago(last, now)})."], a)
    if minutes >= 6000:
        return _pick([f"{hours_text(minutes)} together. Are we married? Are you okay?", f"{hours_text(minutes)}. We should probably see other people."], a)
    if minutes >= 600:
        return _pick([f"{hours_text(minutes)} together. Honestly, we should talk about our relationship.", f"You've put {hours_text(minutes)} into me. Marriage material."], a)
    return _pick([f"{hours_text(minutes)} together. It's getting serious. Or is it?", f"We've been on a few dates ({hours_text(minutes)}). Where is this going?"], a)


def make_card(g: Dict[str, Any], d: Optional[Dict[str, Any]], now: float) -> Dict[str, Any]:
    """Everything the swipe card shows. g: the game as known locally; d: Steam's store details (or None while loading)."""
    owned = g.get("owned", True)
    facts: List[str] = []
    year = (d or {}).get("year")
    if g.get("purchased"):
        facts.append(f"Joined {time.gmtime(g['purchased']).tm_year}")
    if year:
        facts.append(f"{int(time.gmtime(now).tm_year - year)} years old" if time.gmtime(now).tm_year - year >= 1 else "Brand new")
    if owned:
        facts.append("0 km away: installed" if g.get("installed") else "Long distance: not installed")
        if g.get("last_played") and g.get("minutes", 0) >= 1:
            facts.append(f"Last seen {ago(g['last_played'], now)}")
    elif (d or {}).get("price") or g.get("price"):
        p = (d or {}).get("price") or g.get("price")
        facts.append(f"{p} ({g['discount']}% off)" if g.get("discount") else str(p))
    if g.get("review"):
        facts.append(f"{int(g['review'])}% liked me")
    elif (d or {}).get("meta"):
        facts.append(f"Metacritic {d['meta']}")
    desc = (d or {}).get("desc") or ""
    return {"appid": g["appid"], "name": g["name"], "owned": owned, "installed": bool(g.get("installed")),
            "played": round(g.get("minutes", 0) / 60.0, 1), "intro": relation_line(g, d, now), "character": character_line(g["name"], d, g["appid"]),
            "desc": desc, "tags": (d or {}).get("genres", [])[:3], "facts": facts[:4], "loaded": d is not None,
            "discount": g.get("discount", 0), "price": (d or {}).get("price") or g.get("price") or "",
            "img": (d or {}).get("img") or g.get("img") or ""}


def build_deck(library: List[Dict[str, Any]], mode: str, taken: set, now: float) -> List[int]:
    """The app ids to swipe, shuffled. 'taken' = already matched or ghosted."""
    games = [g for g in library if g["appid"] not in taken]
    if mode == "backlog":
        pool = [g for g in games if g.get("minutes", 0) < 60]
    elif mode == "flames":
        pool = [g for g in games if g.get("minutes", 0) >= 120 and (not g.get("last_played") or now - g["last_played"] > 90 * DAY)]
    elif mode == "local":
        pool = [g for g in games if g.get("installed")]
    else:
        return []
    return [g["appid"] for g in shuffled(pool)[:DECK_SIZE]]


# ---------------------------------------------------------------------------
# Plugin
# ---------------------------------------------------------------------------
class Plugin:
    async def _main(self):
        d = decky.DECKY_PLUGIN_SETTINGS_DIR
        self.settings_path = os.path.join(d, "settings.json")
        self.details_path = os.path.join(d, "details.json")
        self.library_path = os.path.join(d, "library.json")
        self.settings = self._load(self.settings_path, {})
        self.matches: Dict[str, Any] = self.settings.get("matches", {}) if isinstance(self.settings.get("matches"), dict) else {}
        self.ghosted: Dict[str, Any] = self.settings.get("ghosted", {}) if isinstance(self.settings.get("ghosted"), dict) else {}
        self.country = str(self.settings.get("country", "us"))[:2] if re.fullmatch(r"[A-Za-z]{2}", str(self.settings.get("country", "us"))) else "us"
        self.details: Dict[str, Any] = self._load(self.details_path, {})                  # appid -> {"ts", "d": compact | None}
        lib = self._load(self.library_path, {})
        self.library: List[Dict[str, Any]] = lib.get("games", []) if isinstance(lib.get("games"), list) else []
        self.library_source = lib.get("source", "")
        self.strangers: Dict[str, Any] = {"ts": 0, "items": []}
        self._queue: List[int] = []
        self._worker: Optional[asyncio.Task] = None
        self._last_steam = 0.0
        self._cool_until = 0.0
        self._offline = False
        self._cancel = False
        log.info(f"Steamder ready ({len(self.library)} games, {len(self.matches)} matches)")

    async def _unload(self):
        self._cancel = True
        if self._worker:
            self._worker.cancel()

    # -- files ----------------------------------------------------------------
    @staticmethod
    def _load(path: str, default: Any) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, type(default)) else default
        except (OSError, ValueError):
            return default

    @staticmethod
    def _save(path: str, data: Any) -> None:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError as e:
            log.warning(f"couldn't save {path}: {e}")

    def _save_settings(self):
        self.settings.update({"matches": self.matches, "ghosted": self.ghosted, "country": self.country})
        self._save(self.settings_path, self.settings)

    # -- Steam's store: details, one game at a time ----------------------------------
    def _fresh(self, appid: int) -> bool:
        e = self.details.get(str(appid))
        if not e:
            return False
        if e.get("d") and "img" not in e["d"]:                      # stored by an older version: fetch again to get the cover address
            return False
        return time.time() - e.get("ts", 0) < (DETAILS_FRESH_DAYS if e.get("d") else MISSING_FRESH_DAYS) * DAY

    async def _steam_pace(self):
        wait = self._last_steam + STEAM_GAP_S - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_steam = time.monotonic()

    async def _fetch_details(self, appid: int) -> bool:
        """-> False when Steam told us to slow down or couldn't be reached (nothing is stored then)."""
        await self._steam_pace()
        status, body, err = await _curl([f"{STORE_DETAILS}?appids={appid}&l=english&cc={self.country}", "-H", f"User-Agent: {STEAM_UA}"])
        if status == 0:
            self._offline = True
            return False
        if status in (403, 429):
            self._cool_until = time.time() + 90
            return False
        if status != 200:
            return False
        self._offline = False
        try:
            node = json.loads(body).get(str(appid))
        except (ValueError, AttributeError):
            return False
        self.details[str(appid)] = {"ts": int(time.time()), "d": compact_details(node)}
        return True

    async def _work(self):
        saved = 0
        try:
            while self._queue and not self._cancel:
                if time.time() < self._cool_until:
                    await asyncio.sleep(5)
                    continue
                appid = self._queue.pop(0)
                if self._fresh(appid):
                    continue
                if not await self._fetch_details(appid):
                    if self._offline:
                        break
                    continue
                saved += 1
                if saved % 5 == 0:
                    self._save(self.details_path, self.details)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("detail lookup failed")
        finally:
            self._save(self.details_path, self.details)

    def _enqueue(self, appids: List[int], front: bool = False) -> None:
        wanted = [a for a in appids if not self._fresh(a) and a not in self._queue]
        self._queue = wanted + self._queue if front else self._queue + wanted
        if self._queue and (self._worker is None or self._worker.done()):
            self._worker = asyncio.create_task(self._work())

    async def _load_strangers(self) -> None:
        if time.time() - self.strangers["ts"] < STRANGERS_FRESH_S and self.strangers["items"]:
            return
        status, body, err = await _curl([f"{STORE_FEATURED}?cc={self.country}&l=english", "-H", f"User-Agent: {STEAM_UA}"])
        if status == 0:
            self._offline = True
            return
        try:
            items = parse_featured(json.loads(body), self.country) if status == 200 else []
        except ValueError:
            items = []
        if items:
            self._offline = False
            self.strangers = {"ts": time.time(), "items": items}

    # -- cards ------------------------------------------------------------------------
    def _local(self, appid: int) -> Optional[Dict[str, Any]]:
        for g in self.library:
            if g["appid"] == appid:
                return dict(g, owned=True)
        for s in self.strangers["items"]:
            if s["appid"] == appid:
                return {"appid": appid, "name": s["name"], "owned": False, "minutes": 0, "discount": s.get("discount", 0), "price": s.get("price", ""), "img": s.get("img", "")}
        snap = self.matches.get(str(appid)) or self.ghosted.get(str(appid))
        if snap and snap.get("stranger"):
            return {"appid": appid, "name": snap.get("name", "?"), "owned": False, "minutes": 0, "discount": snap.get("discount", 0), "price": snap.get("price", ""), "img": snap.get("img", "")}
        return None

    def _card(self, appid: int) -> Optional[Dict[str, Any]]:
        g = self._local(appid)
        if g is None:
            return None
        e = self.details.get(str(appid))
        return make_card(g, (e or {}).get("d"), time.time())

    def _overview(self) -> Dict[str, Any]:
        counts = {m: len(build_deck(self.library, m, self._taken(), time.time())) for m in ("backlog", "flames", "local")}
        return {"library": len(self.library), "library_source": self.library_source, "matches": len(self.matches), "ghosted": len(self.ghosted),
                "decks": counts, "loading": len(self._queue), "offline": self._offline, "country": self.country}

    def _taken(self) -> set:
        return {int(a) for a in list(self.matches) + list(self.ghosted) if str(a).isdigit()}

    # -- API for the panel -----------------------------------------------------------
    async def get_overview(self) -> Dict[str, Any]:
        return self._overview()

    async def sync_library(self, apps: List[Dict[str, Any]], source: str = "") -> Dict[str, Any]:
        clean: Dict[int, Dict[str, Any]] = {}
        for a in apps if isinstance(apps, list) else []:
            try:
                appid = int(a["appid"])
                name = str(a["name"]).strip()[:120]
            except (KeyError, TypeError, ValueError):
                continue
            if not (0 < appid < MAX_APPID) or not name or any(s in name.lower() for s in SKIP_NAMES):
                continue
            clean[appid] = {"appid": appid, "name": name, "minutes": int(_num(a.get("minutes"), 0, 10**7)), "last_played": int(_num(a.get("last_played"), 0, 4e9)),
                            "installed": bool(a.get("installed")), "purchased": int(_num(a.get("purchased"), 0, 4e9)),
                            "review": int(_num(a.get("review"), 0, 100))}
        library, src = sorted(clean.values(), key=lambda g: g["name"].lower()), source
        if not library:
            home = getattr(decky, "DECKY_USER_HOME", "") or os.path.expanduser("~")
            library, src = installed_from_disk(home), "installed games from disk (no playtime)"
        self.library, self.library_source = library, src
        self._save(self.library_path, {"games": library, "source": src})
        return self._overview()

    async def get_deck(self, mode: str = "backlog") -> Dict[str, Any]:
        mode = mode if mode in MODES else "backlog"
        if mode == "new":
            await self._load_strangers()
            taken = self._taken() | {g["appid"] for g in self.library}
            ids = [s["appid"] for s in shuffled(self.strangers["items"]) if s["appid"] not in taken][:DECK_SIZE]
        else:
            ids = build_deck(self.library, mode, self._taken(), time.time())
        self._enqueue(ids[:12], front=True)
        self._enqueue(ids[12:])
        cards = [c for c in (self._card(a) for a in ids) if c]
        return {"mode": mode, "cards": cards, "offline": self._offline,
                "message": "" if cards else ("Couldn't reach Steam's store." if mode == "new" and self._offline else "")}

    async def get_cards(self, appids: List[int]) -> Dict[str, Any]:
        """Fresh versions of some cards (their Steam details may have arrived since the deck was made)."""
        ids = [int(a) for a in appids if isinstance(a, int)][:12]
        self._enqueue(ids, front=True)
        return {"cards": [c for c in (self._card(a) for a in ids) if c], "loading": len(self._queue)}

    async def swipe(self, appid: int, direction: str) -> Dict[str, Any]:
        """direction: right (match), super (match, starred) or left (ghost)."""
        try:
            appid = int(appid)
        except (TypeError, ValueError):
            return {"ok": False, "matched": False, "card": None, "overview": self._overview()}
        g = self._local(appid)
        if g is None:
            return {"ok": False, "matched": False, "card": None, "overview": self._overview()}
        snap: Dict[str, Any] = {"ts": int(time.time() * 1000), "name": g["name"]}
        if not g.get("owned"):
            snap.update({"stranger": True, "discount": g.get("discount", 0), "price": g.get("price", ""), "img": g.get("img", "")})
        key = str(appid)
        self.matches.pop(key, None)
        self.ghosted.pop(key, None)
        matched = direction in ("right", "super")
        if matched:
            snap["super"] = direction == "super"
            self.matches[key] = snap
        elif direction == "left":
            self.ghosted[key] = snap
        else:
            return {"ok": False, "matched": False, "card": None, "overview": self._overview()}
        self._save_settings()
        return {"ok": True, "matched": matched, "card": self._card(appid), "overview": self._overview()}

    async def undo(self, appid: int) -> Dict[str, Any]:
        """Rewind: take back a swipe."""
        self.matches.pop(str(appid), None)
        self.ghosted.pop(str(appid), None)
        self._save_settings()
        return self._overview()

    def _listing(self, store: Dict[str, Any]) -> List[Dict[str, Any]]:
        rows = []
        for a, snap in sorted(store.items(), key=lambda kv: (not kv[1].get("super"), -kv[1].get("ts", 0))):
            card = self._card(int(a))
            if card is None:
                card = make_card({"appid": int(a), "name": snap.get("name", "?"), "owned": not snap.get("stranger"), "minutes": 0}, None, time.time())
            card["super"] = bool(snap.get("super"))
            rows.append(card)
        return rows

    async def get_matches(self) -> Dict[str, Any]:
        rows = self._listing(self.matches)
        self._enqueue([r["appid"] for r in rows if not r["loaded"]][:20])
        return {"items": rows}

    async def get_ghosted(self) -> Dict[str, Any]:
        return {"items": self._listing(self.ghosted)}

    async def unghost_all(self) -> Dict[str, Any]:
        self.ghosted = {}
        self._save_settings()
        return self._overview()

    async def set_country(self, country: str) -> Dict[str, Any]:
        c = str(country or "").strip().lower()
        if re.fullmatch(r"[a-z]{2}", c) and c != self.country:
            self.country = c
            self.strangers = {"ts": 0, "items": []}
            self._save_settings()
        return self._overview()

    async def forget_details(self) -> Dict[str, Any]:
        self.details = {}
        self._queue = []
        self._save(self.details_path, self.details)
        return self._overview()

    async def test_connection(self) -> Dict[str, Any]:
        """Two small requests that show which step works. 620 is Portal 2."""
        lines: List[Dict[str, Any]] = []
        status, body, err = await _curl([f"{STORE_DETAILS}?appids=620&l=english&cc={self.country}", "-H", f"User-Agent: {STEAM_UA}"])
        try:
            d = compact_details(json.loads(body).get("620")) if status == 200 else None
        except (ValueError, AttributeError):
            d = None
        lines.append({"label": "Game details from Steam's store", "ok": bool(d), "detail": (f"Portal 2: {', '.join(d['genres'])}" if d else err or f"HTTP {status}")})
        status, body, err = await _curl([f"{STORE_FEATURED}?cc={self.country}&l=english", "-H", f"User-Agent: {STEAM_UA}"])
        try:
            items = parse_featured(json.loads(body)) if status == 200 else []
        except ValueError:
            items = []
        lines.append({"label": "New games in town (front page lists)", "ok": bool(items), "detail": f"{len(items)} games" if items else err or f"HTTP {status}"})
        return {"ok": all(x["ok"] for x in lines), "lines": lines}


def installed_from_disk(home: str) -> List[Dict[str, Any]]:
    """Fallback when the panel can't read Steam's library: the installed games, from Steam's manifest files."""
    folders = [os.path.join(home, ".local/share/Steam/steamapps"), "/run/media/mmcblk0p1/steamapps"]
    try:
        for d in os.listdir("/run/media"):
            folders.append(os.path.join("/run/media", d, "steamapps"))
    except OSError:
        pass
    games: Dict[int, Dict[str, Any]] = {}
    for folder in folders:
        try:
            names = [n for n in os.listdir(folder) if n.startswith("appmanifest_") and n.endswith(".acf")]
        except OSError:
            continue
        for n in names:
            try:
                with open(os.path.join(folder, n), "r", encoding="utf-8", errors="replace") as f:
                    text = f.read(8192)
            except OSError:
                continue
            a, b = re.search(r'"appid"\s+"(\d+)"', text), re.search(r'"name"\s+"([^"]*)"', text)
            if a and b and not any(s in b.group(1).lower() for s in SKIP_NAMES):
                games[int(a.group(1))] = {"appid": int(a.group(1)), "name": b.group(1), "minutes": 0, "last_played": 0, "installed": True, "purchased": 0, "review": 0}
    return sorted(games.values(), key=lambda g: g["name"].lower())

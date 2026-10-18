import { callable, definePlugin, routerHook } from "@decky/api";
import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  GamepadButton,
  Navigation,
  PanelSection,
  PanelSectionRow,
  Router,
  staticClasses,
  TextField,
} from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaHeart, FaStar, FaTimes, FaUndo } from "react-icons/fa";

// ---------------------------------------------------------------------------------------------
// Types and backend calls
// ---------------------------------------------------------------------------------------------

interface Card {
  appid: number;
  img?: string;
  name: string;
  owned: boolean;
  installed: boolean;
  played: number;
  intro: string;
  character: string;
  desc: string;
  tags: string[];
  facts: string[];
  loaded: boolean;
  discount: number;
  price: string;
  super?: boolean;
}
interface Overview {
  library: number;
  library_source: string;
  matches: number;
  ghosted: number;
  decks: { backlog: number; flames: number; local: number };
  loading: number;
  offline: boolean;
  country: string;
}
interface LibGame {
  appid: number;
  name: string;
  minutes: number;
  last_played: number;
  installed: boolean;
  purchased: number;
  review: number;
}
interface CheckLine {
  label: string;
  ok: boolean;
  detail: string;
}
type Mode = "backlog" | "flames" | "local" | "new";

const getOverview = callable<[], Overview>("get_overview");
const syncLibrary = callable<[LibGame[], string], Overview>("sync_library");
const getDeck = callable<[string], { mode: string; cards: Card[]; offline: boolean; message: string }>("get_deck");
const getCards = callable<[number[]], { cards: Card[]; loading: number }>("get_cards");
const swipeCall = callable<[number, string], { ok: boolean; matched: boolean; card: Card | null; overview: Overview }>("swipe");
const undoCall = callable<[number], Overview>("undo");
const getMatches = callable<[], { items: Card[] }>("get_matches");
const getGhosted = callable<[], { items: Card[] }>("get_ghosted");
const unghostAll = callable<[], Overview>("unghost_all");
const setCountry = callable<[string], Overview>("set_country");
const forgetDetails = callable<[], Overview>("forget_details");
const testConnection = callable<[], { ok: boolean; lines: CheckLine[] }>("test_connection");

// Steam's own focus highlight is hidden by the forced button styles, so focus is tracked here and drawn with the "fx" class.
function FxButton(props: any) {
  const [f, setF] = useState(false);
  return (
    <DialogButton
      {...props}
      className={`${props.className ?? ""}${f ? " fx" : ""}`}
      onGamepadFocus={(e: any) => {
        setF(true);
        props.onGamepadFocus?.(e);
      }}
      onGamepadBlur={(e: any) => {
        setF(false);
        props.onGamepadBlur?.(e);
      }}
    />
  );
}

// Leaving the plugin: Navigation.NavigateBack can quietly do nothing for a plugin page, so try the browser history and the library as well.
function leave() {
  try {
    Navigation.NavigateBack();
  } catch {
    /* try the next way */
  }
  setTimeout(() => {
    if (!UI().querySelector(".sd-rail")) return;
    try {
      (UI().defaultView ?? window).history.back();
    } catch {
      /* try the next way */
    }
  }, 250);
  setTimeout(() => {
    if (!UI().querySelector(".sd-rail")) return;
    try {
      Navigation.Navigate("/library/home");
    } catch {
      /* nothing more to try */
    }
  }, 600);
}

// When the focused button disappears, the D-pad has nothing selected. This puts the focus back on something sensible.
const toRail = (evt: any) => {
  if (DIR_LEFT === undefined || evt?.detail?.button !== DIR_LEFT) return;
  evt.stopPropagation?.();
  (UI().querySelector(".sd-rail .sd-on") as HTMLElement | null)?.focus();
};
// plugin code can run in a different window than the one that shows the page: always query the page's own document
let UIDOC: Document | null = null;
const UI = (): Document => UIDOC ?? document;
const grabDoc = (el: any) => {
  const d = el?.ownerDocument;
  if (d) UIDOC = d;
};
function focusLater(pick: () => Element | null | undefined, ms = 90) {
  setTimeout(() => {
    try {
      (pick() as HTMLElement | null | undefined)?.focus?.();
    } catch {
      /* nothing to focus */
    }
  }, ms);
}
const lastOf = (sel: string) => {
  const all = UI().querySelectorAll(sel);
  return all.length ? all[all.length - 1] : null;
};

// If the plugin's background part never started, a call neither succeeds nor fails: it just never answers.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The plugin's background part isn't answering.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
const errText = (e: unknown) => String((e as any)?.message ?? e);

const ROUTE = "/steamder";
const store = { tab: "swipe", mode: "backlog" as Mode };

// ---------------------------------------------------------------------------------------------
// Reading Steam's library (the panel can see it; the backend can't)
// ---------------------------------------------------------------------------------------------

function readLibrary(): { games: LibGame[]; source: string } {
  const cs = (window as any).collectionStore;
  const installed = new Set<number>();
  try {
    for (const a of cs?.localGamesCollection?.allApps ?? []) if (a && typeof a.appid === "number") installed.add(a.appid);
  } catch {
    /* ignore */
  }
  const sources: [string, () => any[] | undefined][] = [
    ["all games", () => cs?.appTypeCollectionMap?.get?.("type-games")?.allApps],
    ["all games (library)", () => cs?.allGamesCollection?.allApps],
    ["all apps", () => cs?.allAppsCollection?.allApps],
    ["installed games", () => cs?.localGamesCollection?.allApps],
  ];
  for (const [source, read] of sources) {
    let apps: any[] | undefined;
    try {
      apps = read();
    } catch {
      apps = undefined;
    }
    if (!Array.isArray(apps) || apps.length === 0) continue;
    const games = apps
      .filter((a) => a && typeof a.appid === "number" && typeof a.display_name === "string" && a.app_type === 1)
      .map((a) => ({
        appid: a.appid as number,
        name: a.display_name as string,
        minutes: Number(a.minutes_playtime_forever) || 0,
        last_played: Number(a.rt_last_time_played) || 0,
        installed: installed.has(a.appid) || !!a.installed,
        purchased: Number(a.rt_purchased_time) || 0,
        review: Number(a.review_percentage_without_bombs ?? a.review_percentage_with_bombs ?? a.review_percentage) || 0,
      }));
    if (games.length) return { games, source };
  }
  return { games: [], source: "" };
}

function openStore(appid: number) {
  try {
    const sc = (window as any).SteamClient;
    if (sc?.URL?.ExecuteSteamURL) {
      sc.URL.ExecuteSteamURL(`steam://store/${appid}`);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    (Navigation as any).NavigateToExternalWeb(`https://store.steampowered.com/app/${appid}`);
  } catch {
    /* nothing more to try */
  }
}
function playGame(appid: number) {
  Navigation.Navigate(`/library/app/${appid}`);
}
function openCard(c: Card) {
  if (c.owned) playGame(c.appid);
  else openStore(c.appid);
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

function buttonCode(...patterns: RegExp[]): number | undefined {
  const table = (GamepadButton ?? {}) as Record<string, unknown>;
  for (const re of patterns) for (const [name, value] of Object.entries(table)) if (typeof value === "number" && re.test(name)) return value;
  return undefined;
}
const DIR_LEFT = buttonCode(/^DIR_LEFT$/);
const DIR_RIGHT = buttonCode(/^DIR_RIGHT$/);
const DIR_UP = buttonCode(/^DIR_UP$/);
const DIR_DOWN = buttonCode(/^DIR_DOWN$/);
const TRIGGER_LEFT = buttonCode(/^TRIGGER_LEFT$/);
const TRIGGER_RIGHT = buttonCode(/^TRIGGER_RIGHT$/);
const BTN_X = buttonCode(/^SECONDARY$/);
const BTN_Y = buttonCode(/^OPTIONS$/);
const BTN_B = buttonCode(/^CANCEL$/);
const BUMPER_LEFT = buttonCode(/^BUMPER_LEFT$/, /bumper.*left|left.*bumper|^L1$/i);
const BUMPER_RIGHT = buttonCode(/^BUMPER_RIGHT$/, /bumper.*right|right.*bumper|^R1$/i);

// ---------------------------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------------------------

// Newer Steam games keep their art at addresses with a hash in them, so the address Steam gave us (img) is tried first, then the usual ones.
const wide = (appid: number, img?: string) =>
  [
    img || "",
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
  ].filter(Boolean);
const portraitArt = (appid: number) => `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MODE_LABEL: Record<Mode, string> = { backlog: "Backlog", flames: "Old flames", local: "Local singles", new: "New in town" };
const MODE_TAG: Record<Mode, string> = {
  backlog: "Games you own and barely touched",
  flames: "Played a lot once, then nothing for months",
  local: "Installed on this Deck right now",
  new: "Games you don't own yet, straight from Steam's front page",
};

const CSS = `
.sd-seg { display: grid !important; grid-template-columns: repeat(4, 1fr); gap: 6px !important; width: 100%; }
.sd-seg > * { margin: 0 !important; min-width: 0 !important; width: 100% !important; height: 36px !important; min-height: 36px !important;
  padding: 0 4px !important; font-size: 12.5px !important; line-height: 1 !important; display: flex !important; align-items: center !important;
  justify-content: center !important; white-space: nowrap !important; box-sizing: border-box !important; }
.sd-seg .sd-on, .sd-tabs .sd-on { background: #ff4f79 !important; color: #fff !important; font-weight: bold; }
.sd-seg > *, .sd-tabs > * { border-radius: 20px !important; background: rgba(255,255,255,0.08) !important; color: #e8dfe6 !important; }
.sd-seg .sd-on, .sd-tabs .sd-on { background: #ff4f79 !important; color: #fff !important; }
.sd-seg3 { grid-template-columns: repeat(3, 1fr) !important; }
.sd-tabs { display: grid !important; grid-template-columns: repeat(3, 1fr); gap: 8px !important; }
.sd-tabs > * { margin: 0 !important; min-width: 0 !important; width: 100% !important; height: 40px !important; min-height: 40px !important; padding: 0 6px !important;
  font-size: 14px !important; line-height: 1 !important; display: flex !important; align-items: center !important; justify-content: center !important;
  white-space: nowrap !important; overflow: hidden !important; box-sizing: border-box !important; }
.sd-row2 { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 26px; }
.sd-stage { position: relative; height: 100%; max-height: 340px; aspect-ratio: 0.76; flex: none; }
.sd-card { position: absolute; left: 0; top: 0; width: 100%; height: 100%; border-radius: 22px; background: #1d1626; overflow: hidden;
  box-shadow: 0 10px 30px rgba(0,0,0,0.55); touch-action: none; user-select: none; transition: transform .22s ease;
  isolation: isolate; contain: paint; clip-path: inset(0 round 22px); }
.sd-card.sd-drag { transition: none; }
.sd-card.sd-behind { transform: scale(0.94) translateY(14px); opacity: 0.6; pointer-events: none; transition: none; }
.sd-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.sd-bgblur { filter: blur(22px) brightness(0.7); transform: scale(1.3); will-change: transform; }
.sd-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 68%; pointer-events: none;
  background: linear-gradient(to top, rgba(10,6,16,0.97) 0%, rgba(10,6,16,0.88) 45%, rgba(10,6,16,0) 100%); }
.sd-body { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 14px 12px; display: flex; flex-direction: column; gap: 5px; pointer-events: none; }
.sd-name { font-size: 19px; font-weight: 800; color: #fff; line-height: 1.1; max-height: 44px; overflow: hidden; text-shadow: 0 2px 6px rgba(0,0,0,0.6); }
.sd-intro { font-size: 11.5px; color: #fff; line-height: 1.3; max-height: 44px; overflow: hidden; opacity: 0.95; }
.sd-char { font-size: 10.5px; color: #cdb8c4; line-height: 1.3; max-height: 28px; overflow: hidden; font-style: italic; }
.sd-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 40px; overflow: hidden; margin-top: 2px; }
.sd-chip { font-size: 10px; padding: 1px 8px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.55); color: #fff; background: rgba(255,255,255,0.1); white-space: nowrap; }
.sd-chip-hot { border-color: #ff4f79; background: rgba(255,79,121,0.3); }
.sd-stamp { position: absolute; top: 46px; padding: 0 9px; border: 3px solid; border-radius: 8px; font-size: 24px; font-weight: 800; letter-spacing: 2px; }
.sd-like { left: 20px; color: #3ddc97; border-color: #3ddc97; transform: rotate(-14deg); }
.sd-nope { right: 20px; color: #ff5a5f; border-color: #ff5a5f; transform: rotate(14deg); }
.sd-super { left: 50%; margin-left: -45px; top: 120px; color: #4db8ff; border-color: #4db8ff; }
.sd-focus { outline: 3px solid #ff4f79; outline-offset: 4px; border-radius: 26px; }
.sd-side { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 96px; }
.sd-actions { display: flex !important; flex-direction: column; justify-content: center; align-items: center; gap: 12px !important; }
.sd-cap { font-size: 11px; line-height: 1.5; color: #9aa3ad; text-align: center; }
.sd-actions > * { margin: 0 !important; min-width: 0 !important; padding: 0 !important; border-radius: 50% !important; background: #1d1626 !important; border: 2px solid !important;
  display: flex !important; align-items: center !important; justify-content: center !important; box-sizing: border-box !important; flex: none !important; }
.sd-actions > * svg { display: block; }
.sd-b-big { width: 50px !important; height: 50px !important; min-height: 50px !important; font-size: 21px !important; }
.sd-b-small { width: 38px !important; height: 38px !important; min-height: 38px !important; font-size: 15px !important; }
.sd-b-nope { color: #ff5a5f !important; border-color: #ff5a5f !important; }
.sd-b-like { color: #3ddc97 !important; border-color: #3ddc97 !important; }
.sd-b-super { color: #4db8ff !important; border-color: #4db8ff !important; }
.sd-b-undo { color: #ffc83d !important; border-color: #ffc83d !important; }
.sd-page { margin-top: 40px; height: calc(100% - 40px); display: flex; flex-direction: row; box-sizing: border-box; padding: 0 20px 12px; gap: 18px; }
.sd-rail { display: flex !important; flex-direction: column; gap: 9px !important; width: 188px; flex: none; padding: 4px 6px; box-sizing: border-box; }
.sd-rail > * { margin: 0 !important; min-width: 0 !important; width: 100% !important; height: 38px !important; min-height: 38px !important; padding: 0 20px !important; font-size: 13.5px !important; line-height: 1 !important; display: flex !important; align-items: center !important; justify-content: flex-start !important; white-space: nowrap !important; overflow: hidden !important; box-sizing: border-box !important; border-radius: 18px !important; background: rgba(255,255,255,0.08) !important; color: #e8dfe6 !important; }
.sd-rail .sd-on { background: #ff4f79 !important; color: #fff !important; font-weight: bold; }
.sd-rail > .gpfocus, .sd-rail > .fx, .sd-rail > :focus { background: #fff !important; color: #14101a !important; font-weight: bold; box-shadow: 0 0 0 3px #ff4f79 !important; }
.sd-actions > .gpfocus, .sd-actions > .fx, .sd-actions > :focus { box-shadow: 0 0 0 4px #fff !important; transform: scale(1.14); }
.sd-mbtns > .gpfocus, .sd-mbtns > .fx, .sd-rbtns > .gpfocus, .sd-rbtns > .fx { outline: 3px solid #ff4f79 !important; outline-offset: 2px; }
.sd-rail > .sd-gapped { margin-top: 14px !important; }
.sd-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.sd-rule { font-size: 12.5px; color: #9aa3ad; }
.sd-page { background: radial-gradient(ellipse at 62% 45%, rgba(255,79,121,0.14), rgba(255,79,121,0) 62%); }
.sd-rail > .sd-brand { height: auto !important; min-height: 0 !important; padding: 0 6px 6px !important; background: none !important; border-radius: 0 !important; color: #fff !important; font-size: 21px !important; }
.sd-brand { display: flex; align-items: center; gap: 8px; padding: 0 6px 6px; font-size: 21px; font-weight: 800; color: #fff; letter-spacing: 0.5px; }
.sd-brand svg { color: #ff4f79; filter: drop-shadow(0 0 6px rgba(255,79,121,0.7)); }
.sd-stage::before { content: ""; position: absolute; inset: 6% -8% -4%; border-radius: 40px; background: radial-gradient(closest-side, rgba(255,79,121,0.28), rgba(255,79,121,0)); filter: blur(14px); pointer-events: none; }
.sd-badges { position: absolute; left: 10px; right: 10px; top: 12px; display: flex; justify-content: space-between; pointer-events: none; }
.sd-badge { font-size: 10.5px; font-weight: bold; letter-spacing: 0.4px; padding: 3px 10px; border-radius: 12px; background: rgba(10,6,16,0.62); color: #fff; border: 1px solid rgba(255,255,255,0.25); }
.sd-prog { position: absolute; left: 0; top: 0; height: 4px; background: linear-gradient(90deg, #ff4f79, #ff9a5a); pointer-events: none; transition: width .25s; }
.sd-empty-big { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 12px; color: #b4bcc6; font-size: 15px; text-align: center; line-height: 1.5; }
.sd-empty-big svg { font-size: 44px; color: rgba(255,79,121,0.55); }
@keyframes sdpulse { 0% { transform: scale(0.6); opacity: 0; } 55% { transform: scale(1.18); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
.sd-bigheart { font-size: 58px; color: #ff4f79; animation: sdpulse .55s ease-out; filter: drop-shadow(0 0 16px rgba(255,79,121,0.8)); }
.sd-empty { padding: 20px 8px; font-size: 15px; color: #b4bcc6; text-align: center; line-height: 1.5; }
.sd-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 4px 2px 8px; }
.sd-row { display: grid; grid-template-columns: 124px 1fr auto; gap: 16px; align-items: center; padding: 10px 14px 10px 10px; border-radius: 14px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.06); }
.sd-row.sd-rsuper { border-color: rgba(77,184,255,0.55); background: linear-gradient(90deg, rgba(77,184,255,0.14), rgba(255,255,255,0.05)); }
.sd-row-focus { background: rgba(255,79,121,0.3) !important; box-shadow: 0 0 0 2px #ff4f79; }
.sd-art { width: 124px; height: 58px; object-fit: cover; border-radius: 8px; background: rgba(255,255,255,0.06); display: block; }
.sd-rname { font-size: 16px; font-weight: bold; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-rsub { font-size: 12px; color: #9aa3ad; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-rbtns { display: flex; gap: 8px; }
.sd-rbtns > * { margin: 0 !important; min-width: 0 !important; width: auto !important; height: 36px !important; min-height: 36px !important; padding: 0 18px !important; border-radius: 18px !important; background: rgba(255,255,255,0.1) !important;
  font-size: 13px !important; display: flex !important; align-items: center !important; justify-content: center !important; white-space: nowrap !important; box-sizing: border-box !important; }
.sd-match { position: fixed; left: 0; right: 0; bottom: 0; top: 40px; z-index: 50; background: rgba(12,6,20,0.94); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.sd-match h1 { font-size: 38px; margin: 0; font-weight: 800; background: linear-gradient(90deg, #ff4f79, #ff9a5a); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sd-pic { display: block; }
.sd-match .sd-pic { width: 260px; height: 122px; background-size: cover; border-radius: 14px; box-shadow: 0 0 30px rgba(255,79,121,0.5); }
.sd-mbtns { display: grid !important; grid-template-columns: repeat(3, 1fr); gap: 10px !important; width: 520px; }
.sd-mbtns > * { margin: 0 !important; min-width: 0 !important; width: 100% !important; height: 44px !important; min-height: 44px !important; padding: 0 4px !important;
  font-size: 14px !important; font-weight: bold; display: flex !important; align-items: center !important; justify-content: center !important; box-sizing: border-box !important; }
`;

// Walks down a list of addresses until one loads and returns its index (past the end = none loaded).
// The picture is probed with an Image() that is never put on the page, and drawn as a CSS background: other plugins that
// restyle every <img> they find in Steam (3D Game Cases turns any portrait cover into a 3D case) never see Steamder's art.
function useChain(srcs: string[]): number {
  const key = srcs.join("|");
  const [state, setState] = useState({ key, i: 0 });
  const i = state.key === key ? state.i : 0;
  const src = srcs[i];
  useEffect(() => {
    if (!src) return;
    let dead = false;
    const probe = new Image();
    probe.onerror = () => { if (!dead) setState({ key, i: i + 1 }); };
    probe.src = src;
    return () => { dead = true; probe.onerror = null; };
  }, [key, i]);
  return i;
}

const bgStyle = (src: string | undefined, size: string, extra?: any) => ({
  backgroundImage: src ? `url("${src}")` : undefined, backgroundSize: size, backgroundPosition: "center", backgroundRepeat: "no-repeat", ...extra,
});

// A picture that walks down a list of addresses until one loads (a div with a background, not an <img>).
function ChainImg({ srcs, className, style }: { srcs: string[]; className?: string; style?: any }) {
  const i = useChain(srcs);
  return <div className={`sd-pic ${className || ""}`} style={bgStyle(srcs[i], "cover", style)} />;
}

function Thumb({ appid, img }: { appid: number; img?: string }) {
  return <ChainImg className="sd-art" srcs={wide(appid, img)} />;
}

function CardArt({ appid, img }: { appid: number; img?: string }) {
  const srcs = [portraitArt(appid), ...wide(appid, img)];
  const i = useChain(srcs);
  return (
    <>
      <ChainImg className="sd-bg sd-bgblur" srcs={wide(appid, img)} />
      {i === 0 && <div className="sd-pic sd-bg" style={bgStyle(srcs[0], "cover")} />}
      {i > 0 && i < srcs.length && <div className="sd-pic sd-bg" style={bgStyle(srcs[i], "contain", { height: "46%", top: "6%" })} />}
    </>
  );
}

function CardBody({ c }: { c: Card }) {
  const chips = [...c.tags.slice(0, 1), ...c.facts.slice(0, 2)];
  return (
    <>
      <CardArt appid={c.appid} img={c.img} />
      <div className="sd-fade" />
      <div className="sd-body">
        <div className="sd-name">{c.name}</div>
        <div className="sd-intro">{c.intro}</div>
        <div className="sd-char">{c.character}</div>
        <div className="sd-chips">
          {chips.map((t, i) => (
            <span key={t} className={`sd-chip${i < c.tags.slice(0, 1).length ? " sd-chip-hot" : ""}`}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Quick Access panel
// ---------------------------------------------------------------------------------------------

function Content() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [country, setCountryText] = useState("");
  const [msg, setMsg] = useState("");
  const [lines, setLines] = useState<CheckLine[] | null>(null);
  const [working, setWorking] = useState(false);
  const countryInit = useRef(false);

  const sync = async () => {
    try {
      const { games, source } = readLibrary();
      setOv(await withTimeout(syncLibrary(games, source), 12000));
      setError("");
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    sync();
    const t = setInterval(async () => {
      try {
        setOv(await withTimeout(getOverview(), 6000));
      } catch {
        /* keep what is shown */
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (ov && !countryInit.current) {
      countryInit.current = true;
      setCountryText(ov.country.toUpperCase());
    }
  }, [ov]);

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    try {
      await work();
    } catch (e) {
      setMsg(errText(e));
    }
    setWorking(false);
  };
  const start = (mode?: Mode) => {
    if (mode) store.mode = mode;
    store.tab = "swipe";
    Router.CloseSideMenus();
    Navigation.Navigate(ROUTE);
  };

  if (!ov) {
    return (
      <PanelSection title="Steamder">
        <style>{CSS}</style>
      <div ref={grabDoc} style={{ display: "none" }} />
        <PanelSectionRow>
          <Field
            label={error ? "Steamder couldn't start" : "Loading…"}
            description={error ? `${error} Restart Decky, or look at the log in ~/homebrew/logs/Steamder/ for the reason.` : undefined}
          />
        </PanelSectionRow>
        {error && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={sync}>
              Retry
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div ref={grabDoc} style={{ display: "none" }} />
      <PanelSection title="Find your next love">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => start()}>
            Start swiping
          </ButtonItem>
        </PanelSectionRow>
        {(["backlog", "flames", "local", "new"] as Mode[]).map((m) => (
          <PanelSectionRow key={m}>
            <ButtonItem
              layout="below"
              onClick={() => start(m)}
              description={m === "new" ? MODE_TAG[m] : `${ov.decks[m]} waiting. ${MODE_TAG[m]}`}
            >
              {MODE_LABEL[m]}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>
      <PanelSection title="Your dating history">
        <PanelSectionRow>
          <Field
            label={`${ov.matches} matches, ${ov.ghosted} ghosted`}
            description={ov.library ? `${ov.library} games in your library (${ov.library_source})` : "No games found in the library yet."}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() => {
              store.tab = "matches";
              Router.CloseSideMenus();
              Navigation.Navigate(ROUTE);
            }}
          >
            See my matches
          </ButtonItem>
        </PanelSectionRow>
        {ov.ghosted > 0 && (
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={working} onClick={() => run(async () => setOv(await withTimeout(unghostAll(), 8000)))}>
              Give all ghosted games a second chance
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
      <PanelSection title="Settings">
        <PanelSectionRow>
          <TextField
            label="Store country (two letters, for prices)"
            value={country}
            onChange={(e: any) => setCountryText(String(e?.target?.value ?? "").slice(0, 2))}
            onBlur={() => run(async () => setOv(await withTimeout(setCountry(country), 8000)))}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={working}
            onClick={() =>
              run(async () => {
                setMsg("Checking…");
                const r = await withTimeout(testConnection(), 40000);
                setLines(r.lines);
                setMsg("");
              })
            }
          >
            Test Steam connection
          </ButtonItem>
        </PanelSectionRow>
        {lines &&
          lines.map((l) => (
            <PanelSectionRow key={l.label}>
              <Field label={`${l.ok ? "OK" : "Failed"}: ${l.label}`} description={l.detail} />
            </PanelSectionRow>
          ))}
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={working}
            onClick={() => run(async () => setOv(await withTimeout(forgetDetails(), 8000)))}
            description="Clears the stored bios. They are fetched again when needed."
          >
            Forget Steam details
          </ButtonItem>
        </PanelSectionRow>
        {ov.offline && (
          <PanelSectionRow>
            <Field label="Steam's store isn't reachable" description="Cards still work with local info. 'New in town' needs the store." />
          </PanelSectionRow>
        )}
        {msg && (
          <PanelSectionRow>
            <Field label={msg} />
          </PanelSectionRow>
        )}
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Swiping
// ---------------------------------------------------------------------------------------------

function SwipeTab({ mode, onChanged }: { mode: Mode; onChanged: () => void }) {
  const [deck, setDeck] = useState<Card[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<{ appid: number; dir: string }[]>([]);
  const [matchN, setMatchN] = useState(0);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [match, setMatch] = useState<Card | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const down = useRef(false);
  const moved = useRef(false);
  const alive = useRef(true);
  const deckRef = useRef<Card[] | null>(null);
  const idxRef = useRef(0);
  deckRef.current = deck;
  idxRef.current = idx;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setDeck(null);
    setIdx(0);
    setHist([]);
    setErr("");
    setNote("");
    withTimeout(getDeck(mode), 15000)
      .then((d) => {
        if (!alive.current) return;
        setDeck(d.cards);
        setNote(d.message);
      })
      .catch((e) => alive.current && setErr(errText(e)));
  }, [mode]);

  // Steam's details arrive one game at a time in the background; refresh the next few cards until they have bios.
  useEffect(() => {
    const t = setInterval(async () => {
      const d = deckRef.current;
      if (!d) return;
      const upcoming = d.slice(idxRef.current, idxRef.current + 6).filter((c) => !c.loaded);
      if (upcoming.length === 0) return;
      try {
        const r = await withTimeout(getCards(upcoming.map((c) => c.appid)), 6000);
        if (!alive.current || r.cards.length === 0) return;
        const fresh = new Map(r.cards.map((c) => [c.appid, c]));
        setDeck((cur) => (cur ? cur.map((c) => fresh.get(c.appid) ?? c) : cur));
      } catch {
        /* try again next time */
      }
    }, 2500);
    return () => clearInterval(t);
  }, []);

  const card = deck?.[idx];
  const behind = deck?.[idx + 1];

  const commit = async (dir: "left" | "right" | "super") => {
    if (!card || busy || match) return;
    setBusy(true);
    setDragging(false);
    if (dir === "super") setDy(-500);
    else setDx(dir === "right" ? 900 : -900);
    await sleep(230);
    let matched: Card | null = null;
    try {
      const r = await withTimeout(swipeCall(card.appid, dir), 8000);
      if (r.ok) {
        setHist((h) => [...h, { appid: card.appid, dir }]);
        if (r.matched) {
          setMatchN((n) => n + 1);
          matched = r.card ?? card;
        }
        onChanged();
      }
    } catch (e) {
      setErr(errText(e));
    }
    setIdx((i) => i + 1);
    setDx(0);
    setDy(0);
    setBusy(false);
    if (matched) setMatch(matched);
  };
  const undo = async () => {
    const last = hist[hist.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      await withTimeout(undoCall(last.appid), 8000);
      setHist((h) => h.slice(0, -1));
      if (last.dir !== "left") setMatchN((n) => Math.max(0, n - 1));
      setIdx((i) => Math.max(0, i - 1));
      onChanged();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };

  // B on the card or the round buttons: back to the side menu (the page handler then leaves from there)
  const toMenu = (evt: any) => {
    evt?.stopPropagation?.();
    if (UI().querySelector(".sd-match")) return;
    focusLater(() => lastOf(".sd-rail .sd-on"), 20);
    focusLater(() => (UI().activeElement?.closest?.(".sd-rail") ? null : lastOf(".sd-rail .sd-on")), 200);
  };
  const keys = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === undefined) return;
    if (BTN_B !== undefined && b === BTN_B) return toMenu(evt);
    // D-pad moves around (left = side menu, right or down = the round buttons); swiping is L1/R1, L2/R2, X, Y or the buttons
    if (DIR_LEFT !== undefined && b === DIR_LEFT) {
      evt.stopPropagation?.();
      focusLater(() => UI().querySelector(".sd-rail .sd-on"), 0);
    } else if ((DIR_RIGHT !== undefined && b === DIR_RIGHT) || (DIR_DOWN !== undefined && b === DIR_DOWN)) {
      evt.stopPropagation?.();
      focusLater(() => UI().querySelector(".sd-b-like"), 0);
    } else if (DIR_UP !== undefined && b === DIR_UP) commit("super");
  };
  // L1/R1 and the triggers work anywhere on the swipe page; X = super like, Y = rewind
  const pad = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === undefined) return;
    if ((BUMPER_LEFT !== undefined && b === BUMPER_LEFT) || (TRIGGER_LEFT !== undefined && b === TRIGGER_LEFT)) commit("left");
    else if ((BUMPER_RIGHT !== undefined && b === BUMPER_RIGHT) || (TRIGGER_RIGHT !== undefined && b === TRIGGER_RIGHT)) commit("right");
    else if (BTN_X !== undefined && b === BTN_X) commit("super");
    else if (BTN_Y !== undefined && b === BTN_Y) undo();
  };
  const closeMatch = () => {
    setMatch(null);
    focusLater(() => UI().querySelector(".sd-b-like"));
  };
  const pdown = (e: any) => {
    if (busy || match) return;
    down.current = true;
    moved.current = false;
    start.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* not supported */
    }
  };
  const pmove = (e: any) => {
    if (!down.current) return;
    if (Math.abs(e.clientX - start.current.x) > 10 || Math.abs(e.clientY - start.current.y) > 10) moved.current = true;
    setDx(e.clientX - start.current.x);
    setDy(Math.min(0, e.clientY - start.current.y));
  };
  const pup = () => {
    if (!down.current) return;
    down.current = false;
    if (dy < -120 && Math.abs(dx) < 100) commit("super");
    else if (Math.abs(dx) > 120) commit(dx > 0 ? "right" : "left");
    else {
      setDragging(false);
      setDx(0);
      setDy(0);
    }
  };
  const stamp = (v: number) => Math.max(0, Math.min(1, v / 130));
  const left = deck ? Math.max(0, deck.length - idx) : 0;
  const finished = !!deck && !card;
  useEffect(() => {
    if (finished) focusLater(() => lastOf(".sd-rail .sd-on"));
  }, [finished]);

  return (
    <Focusable style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, position: "relative" }} flow-children="vertical" onButtonDown={pad}>
      {err && <div className="sd-empty">{err}</div>}
      {deck === null && !err && <div className="sd-empty">Shuffling the deck…</div>}
      {deck && !card && (
        <div className="sd-empty-big">
          <FaHeart />
          {deck.length === 0
            ? note ||
              (mode === "new"
                ? "Nobody new in town. Try again later."
                : mode === "local"
                  ? "No installed games left to judge. Everyone here has been seen."
                  : "Nobody left in this group. You've been very decisive.")
            : matchN > 0
              ? `That's everyone for now. ${matchN} new match${matchN === 1 ? "" : "es"}: go play them.`
              : "That's everyone for now. Picky, aren't we?"}
        </div>
      )}
      {card && (
        <div className="sd-row2">
          <div className="sd-stage" data-sanso-skip="1">
            {behind && (
              <div className="sd-card sd-behind" data-sanso-skip="1">
                <CardBody c={behind} />
              </div>
            )}
            <Focusable
              style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
              className="sd-cardfocus"
              focusClassName="sd-focus"
              onActivate={() => {
                // a drag also ends in a click: only a real tap or the A button opens the game
                if (moved.current) moved.current = false;
                else openCard(card);
              }}
              onOKActionDescription={card.owned ? "Open in your library" : "Open the Steam store page"}
              onSecondaryActionDescription="Super like"
              onOptionsActionDescription="Rewind"
              onButtonDown={keys}
              onCancel={toMenu}
              onCancelActionDescription="Back"
            >
              <div
                className={`sd-card${dragging ? " sd-drag" : ""}`}
                data-sanso-skip="1"
                style={{ transform: `translate(${dx}px, ${dy}px) rotate(${dx / 28}deg)` }}
                onPointerDown={pdown}
                onPointerMove={pmove}
                onPointerUp={pup}
                onPointerCancel={pup}
              >
                <CardBody c={card} />
                <div className="sd-prog" style={{ width: `${deck ? Math.round(((idx + 1) / deck.length) * 100) : 0}%` }} />
                <div className="sd-badges">
                  <span className="sd-badge">{MODE_LABEL[mode]}</span>
                  <span className="sd-badge">{`${idx + 1} / ${deck ? deck.length : 0}`}</span>
                </div>
                <div className="sd-stamp sd-like" style={{ opacity: stamp(dx) }}>
                  LIKE
                </div>
                <div className="sd-stamp sd-nope" style={{ opacity: stamp(-dx) }}>
                  NOPE
                </div>
                <div className="sd-stamp sd-super" style={{ opacity: stamp(-dy - 20) }}>
                  SUPER
                </div>
              </div>
            </Focusable>
          </div>
          <div className="sd-side">
            <Focusable
              className="sd-actions"
              flow-children="vertical"
              onCancel={toMenu}
              onCancelActionDescription="Back"
              onButtonDown={(evt: any) => {
                if (BTN_B !== undefined && evt?.detail?.button === BTN_B) return toMenu(evt);
                if (DIR_LEFT !== undefined && evt?.detail?.button === DIR_LEFT) {
                  evt.stopPropagation?.();
                  focusLater(() => UI().querySelector(".sd-cardfocus"), 0);
                }
              }}
            >
            <FxButton className="sd-b-small sd-b-undo" style={{ opacity: busy || hist.length === 0 ? 0.35 : 1 }} onClick={undo}>
              <FaUndo />
            </FxButton>
            <FxButton className="sd-b-big sd-b-nope" onClick={() => commit("left")}>
              <FaTimes />
            </FxButton>
            <FxButton className="sd-b-big sd-b-like" onClick={() => commit("right")}>
              <FaHeart />
            </FxButton>
            <FxButton className="sd-b-small sd-b-super" onClick={() => commit("super")}>
              <FaStar />
            </FxButton>
          </Focusable>
            <div className="sd-cap">
              {`${left} left`}
              <br />
              {`${matchN} match${matchN === 1 ? "" : "es"}`}
              <br />
              {"L1 / R1: nope / like"}
              <br />
              {"X: super like"}
              <br />
              {"A opens the game"}
            </div>
          </div>
        </div>
      )}
      {match && (
        <Focusable
          className="sd-match"
          onCancel={(e: any) => {
            e?.stopPropagation?.();
            closeMatch();
          }}
          onCancelActionDescription="Keep swiping"
        >
          <FaHeart className="sd-bigheart" />
          <h1>It's a match!</h1>
          <ChainImg srcs={wide(match.appid, match.img)} />
          <div className="sd-name" style={{ maxWidth: 540, textAlign: "center" }}>
            {match.name}
          </div>
          <div className="sd-rule" style={{ maxWidth: 520, textAlign: "center" }}>
            {match.owned ? "You two have so much in common. Don't leave it on read." : "Go on, ask it out."}
          </div>
          <Focusable className="sd-mbtns" flow-children="horizontal">
            <FxButton
              onClick={() => {
                const m = match;
                setMatch(null);
                openCard(m);
                Router.CloseSideMenus();
              }}
            >
              {match.owned ? "Play now" : "Open store page"}
            </FxButton>
            <FxButton
              onClick={async () => {
                const m = match;
                closeMatch();
                try {
                  await withTimeout(undoCall(m.appid), 8000);
                  setHist((h) => h.filter((x) => x.appid !== m.appid));
                  setMatchN((n) => Math.max(0, n - 1));
                  onChanged();
                } catch (e) {
                  setErr(errText(e));
                }
              }}
            >
              Cancel match
            </FxButton>
            <FxButton autoFocus onClick={closeMatch}>Keep swiping</FxButton>
          </Focusable>
        </Focusable>
      )}
    </Focusable>
  );
}

// ---------------------------------------------------------------------------------------------
// Matches and ghosted
// ---------------------------------------------------------------------------------------------

function ListTab({ kind, version, onChanged }: { kind: "matches" | "ghosted"; version: number; onChanged: () => void }) {
  const [items, setItems] = useState<Card[] | null>(null);
  const [err, setErr] = useState("");
  const load = async () => {
    try {
      const r = await withTimeout(kind === "matches" ? getMatches() : getGhosted(), 8000);
      setItems(r.items);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  };
  useEffect(() => {
    setItems(null);
    load();
  }, [kind, version]);
  useEffect(() => {
    const t = setInterval(() => {
      if (items && items.some((c) => !c.loaded)) load();
    }, 4000);
    return () => clearInterval(t);
  }, [items, kind]);

  const remove = async (c: Card) => {
    const at = items ? items.findIndex((x) => x.appid === c.appid) : 0;
    try {
      await withTimeout(undoCall(c.appid), 8000);
      setItems((cur) => (cur ? cur.filter((x) => x.appid !== c.appid) : cur));
      onChanged();
      focusLater(() => {
        const rows = UI().querySelectorAll(".sd-rows .sd-row");
        const row = rows[Math.min(Math.max(at, 0), rows.length - 1)];
        return row?.querySelector(".sd-rbtns button:last-child") ?? lastOf(".sd-rail .sd-on");
      });
    } catch (e) {
      setErr(errText(e));
    }
  };
  if (err) return <div className="sd-empty">{err}</div>;
  if (!items) return <div className="sd-empty">Loading…</div>;
  if (items.length === 0)
    return (
      <div className="sd-empty-big">
        <FaHeart />
        {kind === "matches" ? "No matches yet. Swipe right on something. Be brave." : "Nobody ghosted yet. Everyone is still hopeful."}
      </div>
    );
  return (
    <Focusable className="sd-rows" flow-children="vertical" onButtonDown={toRail}>
      {items.map((c) => (
        <Focusable key={c.appid} className={`sd-row${c.super ? " sd-rsuper" : ""}`} focusClassName="sd-row-focus" flow-children="horizontal" onActivate={() => openCard(c)}>
          <Thumb appid={c.appid} img={c.img} />
          <div style={{ minWidth: 0 }}>
            <div className="sd-rname">
              {c.super && <FaStar style={{ color: "#4db8ff", marginRight: 6, verticalAlign: "-1px" }} />}
              {c.name}
            </div>
            <div className="sd-rsub">{kind === "matches" ? c.intro : c.character}</div>
          </div>
          <Focusable className="sd-rbtns" flow-children="horizontal">
            <FxButton onClick={() => openCard(c)}>{c.owned ? "Play" : "Store"}</FxButton>
            <FxButton onClick={() => remove(c)}>{kind === "matches" ? "Unmatch" : "Give a chance"}</FxButton>
          </Focusable>
        </Focusable>
      ))}
    </Focusable>
  );
}

// ---------------------------------------------------------------------------------------------
// Full-screen page
// ---------------------------------------------------------------------------------------------

function SteamderPage() {
  const [tab, setTab] = useState(store.tab);
  const [ov, setOv] = useState<Overview | null>(null);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<Mode>(store.mode);
  const refresh = async () => {
    try {
      setOv(await withTimeout(getOverview(), 6000));
    } catch {
      /* keep */
    }
  };
  useEffect(() => {
    (async () => {
      try {
        const { games, source } = readLibrary();
        if (games.length) setOv(await withTimeout(syncLibrary(games, source), 12000));
        else await refresh();
      } catch {
        await refresh();
      }
    })();
  }, []);
  const changed = () => {
    refresh();
  };
  const go = (t: string) => {
    store.tab = t;
    setTab(t);
    setVersion((v) => v + 1);
  };
  // B goes back one level: card or list -> side menu -> Swipe tab -> out of the plugin
  const back = (e: any) => {
    e?.stopPropagation?.();
    if (UI().querySelector(".sd-match")) return;
    const inRail = !!UI().activeElement?.closest?.(".sd-rail");
    if (!inRail) {
      focusLater(() => (tab === "swipe" ? lastOf(".sd-rail .sd-on") : UI().querySelector(".sd-rail .sd-on")), 30);
    } else if (tab !== "swipe") {
      go("swipe");
      focusLater(() => lastOf(".sd-rail .sd-on"), 120);
    } else {
      leave();
    }
  };
  return (
    <Focusable className="sd-page" onCancel={back} onCancelActionDescription="Back">
      <style>{CSS}</style>
      <div ref={grabDoc} style={{ display: "none" }} />
      <Focusable
        className="sd-rail"
        flow-children="vertical"
        onButtonDown={(evt: any) => {
          const b = evt?.detail?.button;
          const order = ["swipe", "matches", "ghosted"];
          const i = order.indexOf(tab);
          if (BUMPER_LEFT !== undefined && b === BUMPER_LEFT && i > 0) go(order[i - 1]);
          else if (BUMPER_RIGHT !== undefined && b === BUMPER_RIGHT && i < order.length - 1) go(order[i + 1]);
          else if (DIR_RIGHT !== undefined && b === DIR_RIGHT) {
            // into the page: the card when swiping, the first row in the lists
            const target = UI().querySelector(tab === "swipe" ? ".sd-cardfocus" : ".sd-rows .sd-rbtns button") as HTMLElement | null;
            if (target) {
              evt.stopPropagation?.();
              target.focus();
            }
          }
        }}
      >
        <div className="sd-brand">
          <FaHeart />
          Steamder
        </div>
        <FxButton className={tab === "swipe" ? "sd-on" : ""} onClick={() => go("swipe")}>
          Swipe
        </FxButton>
        <FxButton className={tab === "matches" ? "sd-on" : ""} onClick={() => go("matches")}>
          {`Matches${ov ? ` (${ov.matches})` : ""}`}
        </FxButton>
        <FxButton className={tab === "ghosted" ? "sd-on" : ""} onClick={() => go("ghosted")}>
          {`Ghosted${ov ? ` (${ov.ghosted})` : ""}`}
        </FxButton>
        {tab === "swipe" &&
          (["backlog", "flames", "local", "new"] as Mode[]).map((m) => (
            <FxButton
              key={m}
              className={`${mode === m ? "sd-on" : ""}${m === "backlog" ? " sd-gapped" : ""}`}
              onClick={() => {
                store.mode = m;
                setMode(m);
              }}
            >
              {MODE_LABEL[m]}
            </FxButton>
          ))}
      </Focusable>
      <div className="sd-main">
        {tab === "swipe" && <SwipeTab mode={mode} onChanged={changed} />}
        {tab === "matches" && <ListTab kind="matches" version={version} onChanged={changed} />}
        {tab === "ghosted" && <ListTab kind="ghosted" version={version} onChanged={changed} />}
      </div>
    </Focusable>
  );
}

export default definePlugin(() => {
  routerHook.addRoute(ROUTE, SteamderPage);
  return {
    name: "Steamder",
    titleView: <div className={staticClasses.Title}>Steamder</div>,
    content: <Content />,
    icon: <FaHeart />,
    onDismount() {
      routerHook.removeRoute(ROUTE);
    },
  };
});

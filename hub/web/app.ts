// Renders the hub from /data/*.json, adds like counts when they're available, and runs the suggestion form.
// Bundled with nav.ts and receipts.ts into public/app.js at build time (see wrangler.jsonc).
import "./nav.ts";
import * as store from "./receipts.ts";

type Project = { name: string; title: string; url: string; repo: string; preview: string; tagline: string; tech?: string[]; launched?: string };
type Change = { repo: string; title: string; url: string; mergedAt: string };
type RoadmapItem = { number: number; title: string; url: string; fromVisitor: boolean };
type Likes = Record<string, { total: number; week: number }>;
type Card = { p: Project; i: number; li: HTMLLIElement };

// The page's own elements: a missing one is a bug in index.html, not something to handle here.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string | null | undefined)[]
) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};
const getJson = <T,>(path: string): Promise<T[]> => fetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// Asked quietly (204 instead of 503) so a missing likes table never shows as a console error.
// Started before the cards render, but never waited for: the cards paint first, counts follow.
const likesReady: Promise<Likes | null> = fetch("/api/likes?quiet=1")
  .then((r) => (r.status === 200 ? r.json() : null))
  .then((d) => (d && typeof d === "object" && !Array.isArray(d) ? d : null))
  .catch(() => null);

async function render() {
  const [projects, changes, roadmap] = await Promise.all([
    getJson<Project>("/data/projects.json"), getJson<Change>("/data/changelog.json"), getJson<RoadmapItem>("/data/roadmap.json"),
  ]);

  const cards: Card[] = projects.map((p, i) => ({ p, i, li: el("li", {},
    el("article", { className: "card" },
      el("a", { href: p.url, tabIndex: -1, ariaHidden: "true" },
        el("img", { src: p.preview, alt: "", loading: "lazy", width: 960, height: 600 })),
      el("div", { className: "body" },
        el("div", { className: "head" }, el("h3", {}, p.title)),
        el("p", {}, p.tagline),
        el("span", { className: "tech" }, (p.tech ?? []).join(", ")),
        el("div", { className: "actions" },
          el("a", { className: "btn primary", href: p.url }, `Play ${p.title}`),
          el("a", { className: "btn", href: `https://github.com/${p.repo}` }, "Source"))))) }));
  $("projects").replaceChildren(...cards.map((c) => c.li));
  likesReady.then((likes) => likes && showLikes(cards, likes));

  const select = $<HTMLSelectElement>("s-project");
  for (const p of projects) select.append(el("option", { value: p.name }, p.title));

  const log = $("changelog");
  if (changes.length) {
    log.replaceChildren(...changes.slice(0, 12).map((c) => el("li", {},
      el("time", { dateTime: c.mergedAt }, day(c.mergedAt)),
      el("span", {}, el("a", { href: c.url }, c.title), " ", el("span", { className: "proj" }, c.repo.split("/")[1] ?? c.repo)))));
    const last = changes[0]!;
    $("shift").textContent = `Last night shift: ${day(last.mergedAt)}, shipped “${last.title}”`;
  } else {
    log.replaceChildren(el("li", { className: "empty" }, "The first night shift hasn't shipped anything yet. Check back tomorrow morning."));
    $("shift").textContent = "The night shift starts at 02:00 Central European Time";
  }

  $("roadmap").replaceChildren(...(roadmap.length
    ? roadmap.slice(0, 8).map((i) => el("li", {},
        el("a", { href: i.url }, i.title),
        el("span", { className: "who" }, i.fromVisitor ? "Suggested by a visitor" : "On the list")))
    : [el("li", { className: "empty" }, "Nothing queued. Suggest something below.")]));
}

// ── Likes: a heart and count on each card. The browser keeps its own receipts (see receipts.ts) so it can unlike.
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>';
let live: HTMLElement | null = null; // one polite announcer for likes, unlikes and their errors
let storage: Storage | null = null;
try { storage = window.localStorage; } catch {}
let receipts: store.Receipts = {}; // this tab's copy; storage is the truth whenever it's usable
const fresh = () => (receipts = store.readReceipts(storage, receipts));
const remember = (name: string, receipt: string | null) => (receipts = store.saveReceipt(storage, name, receipt, receipts));

function showLikes(cards: Card[], likes: Likes) {
  fresh();
  const week = (c: Card | undefined) => (c ? likes[c.p.name]?.week ?? 0 : 0);
  const total = (c: Card) => likes[c.p.name]?.total ?? NaN; // not a number: the API doesn't know this project
  const known = cards.filter((c) => Number.isFinite(total(c)));
  if (!known.length) return;
  // Most liked this week first, then the newest launch.
  const order = [...cards].sort((a, b) => week(b) - week(a) || (b.p.launched ?? "").localeCompare(a.p.launched ?? "") || a.i - b.i);
  $("projects").append(...order.map((c) => c.li));
  const [top, next] = order;
  if (top && week(top) > 0 && (!next || week(top) > week(next))) {
    top.li.querySelector(".head h3")!.after(el("span", { className: "top" }, "Most liked"));
  }
  live = el("p", { className: "sr-only", role: "status" });
  document.body.append(live);
  const buttons = new Map<string, HTMLButtonElement>();
  for (const c of known) {
    // The name stays "Like <title>"; the count is visible text and the button's description.
    const id = `like-n-${c.p.name}`;
    const btn = el("button", { type: "button", className: "like", innerHTML: HEART, ariaLabel: `Like ${c.p.title}` });
    btn.append(el("span", { className: "like__n", ariaHidden: "true" }), el("span", { id, className: "like__d", hidden: true }));
    btn.setAttribute("aria-describedby", id);
    const note = el("p", { className: "like-note", hidden: true, ariaHidden: "true" });
    setLike(btn, Boolean(receipts[c.p.name]), total(c));
    btn.addEventListener("click", () => toggleLike(btn, note, c.p));
    c.li.querySelector(".head")!.append(btn, note);
    buttons.set(c.p.name, btn);
  }
  // Another tab liked or unliked something: show it here too, with that tab's change to the count.
  addEventListener("storage", (e) => {
    if (e.key !== store.STORE && e.key !== null) return;
    const before = receipts;
    for (const name of store.flipped(before, fresh())) {
      const btn = buttons.get(name);
      if (!btn || btn.getAttribute("aria-busy") === "true") continue; // a like in flight here settles itself
      setLike(btn, Boolean(receipts[name]), Number(btn.dataset.n) + (receipts[name] ? 1 : -1));
    }
  });
}

function setLike(btn: HTMLButtonElement, liked: boolean, n: number) {
  n = Math.max(0, n);
  btn.dataset.n = String(n);
  btn.setAttribute("aria-pressed", String(liked));
  btn.querySelector(".like__n")!.textContent = String(n);
  btn.querySelector(".like__d")!.textContent = `${n} ${n === 1 ? "like" : "likes"}`;
}

// Errors show under the card; everything is also read out politely.
function say(note: HTMLElement, text: string, error = false) {
  note.textContent = error ? text : "";
  note.hidden = !error;
  if (live) live.textContent = text;
}

async function toggleLike(btn: HTMLButtonElement, note: HTMLElement, p: Project) {
  if (btn.getAttribute("aria-busy") === "true") return;
  const receipt = fresh()[p.name];
  const liked = Boolean(receipt);
  const before = Number(btn.dataset.n);
  setLike(btn, !liked, before + (liked ? -1 : 1)); // show it right away, settle with the server's count
  if (!liked) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  say(note, "");
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await fetch(`/api/likes/${encodeURIComponent(p.name)}`, liked
      ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt }) }
      : { method: "POST" });
    const data: { total?: number; receipt?: unknown; error?: string } = await r.json().catch(() => ({}));
    const n = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : null;
    if (liked && (r.ok || r.status === 404)) { // 404: that like is already gone
      remember(p.name, null);
      setLike(btn, false, n ?? before - 1);
      say(note, `Unliked ${p.title}`);
    } else if (!liked && r.ok && typeof data.receipt === "string") {
      remember(p.name, data.receipt);
      setLike(btn, true, n ?? before + 1);
      say(note, `Liked ${p.title}`);
    } else {
      setLike(btn, liked, n ?? before);
      say(note, data.error || "That didn't go through. Try again in a minute.", true);
    }
  } catch {
    setLike(btn, liked, before);
    say(note, "You seem to be offline. Try again when you're connected.", true);
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

function setupForm() {
  const form = $<HTMLFormElement>("suggest-form");
  const text = $<HTMLTextAreaElement>("s-text");
  const status = $("s-status");
  const count = $("s-count");
  text.addEventListener("input", () => { count.textContent = `${[...text.value].length} / 500`; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = text.value.trim();
    status.className = "status";
    if ([...value].length < 3) {
      status.textContent = "Write at least a few words.";
      status.classList.add("bad");
      text.focus();
      return;
    }
    const button = form.querySelector("button")!;
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const r = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value, project: $<HTMLSelectElement>("s-project").value || null, website: $<HTMLInputElement>("s-website").value }),
      });
      const data: { error?: string } = await r.json().catch(() => ({}));
      if (r.ok) {
        status.textContent = "Sent. Thanks! The night shift will read it tonight.";
        status.classList.add("ok");
        form.reset();
        count.textContent = "0 / 500";
      } else {
        status.textContent = data.error || "That didn't go through. Try again in a minute.";
        status.classList.add("bad");
      }
    } catch {
      status.textContent = "You seem to be offline. Try again when you're connected.";
      status.classList.add("bad");
    } finally {
      button.disabled = false;
    }
  });
}

render();
setupForm();

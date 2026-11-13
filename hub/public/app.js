// Renders the hub from /data/*.json, adds like counts when they're available, and runs the suggestion form.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};
const getJson = (path) => fetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// Asked quietly (204 instead of 503) so a missing likes table never shows as a console error.
// Started before the cards render, but never waited for: the cards paint first, counts follow.
const likesReady = fetch("/api/likes?quiet=1")
  .then((r) => (r.status === 200 ? r.json() : null))
  .then((d) => (d && typeof d === "object" && !Array.isArray(d) ? d : null))
  .catch(() => null);

async function render() {
  const [projects, changes, roadmap] = await Promise.all([
    getJson("/data/projects.json"), getJson("/data/changelog.json"), getJson("/data/roadmap.json"),
  ]);

  const cards = projects.map((p, i) => ({ p, i, li: el("li", {},
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

  const select = $("s-project");
  for (const p of projects) select.append(el("option", { value: p.name }, p.title));

  const log = $("changelog");
  if (changes.length) {
    log.replaceChildren(...changes.slice(0, 12).map((c) => el("li", {},
      el("time", { dateTime: c.mergedAt }, day(c.mergedAt)),
      el("span", {}, el("a", { href: c.url }, c.title), " ", el("span", { className: "proj" }, c.repo.split("/")[1])))));
    const last = changes[0];
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

// ── Likes: a heart and count on each card. The browser keeps its own receipts so it can unlike.
const STORE = "lab:likes";
const receipts = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(STORE));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
})();
function remember(name, receipt) {
  if (receipt) receipts[name] = receipt; else delete receipts[name];
  try { localStorage.setItem(STORE, JSON.stringify(receipts)); } catch {}
}
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>';
let live = null; // one polite announcer for like errors

function showLikes(cards, likes) {
  const week = (c) => likes[c.p.name]?.week ?? 0;
  const known = cards.filter((c) => Number.isFinite(likes[c.p.name]?.total));
  if (!known.length) return;
  // Most liked this week first, then the newest launch.
  const order = [...cards].sort((a, b) => week(b) - week(a) || (b.p.launched ?? "").localeCompare(a.p.launched ?? "") || a.i - b.i);
  $("projects").append(...order.map((c) => c.li));
  const [top, next] = order;
  if (week(top) > 0 && (!next || week(top) > week(next))) {
    top.li.querySelector(".head h3").after(el("span", { className: "top" }, "Most liked"));
  }
  live = el("p", { className: "sr-only", role: "status" });
  document.body.append(live);
  for (const c of known) {
    const btn = el("button", { type: "button", className: "like", innerHTML: HEART });
    btn.append(el("span", { className: "like__n" }));
    const note = el("p", { className: "like-note", hidden: true, ariaHidden: "true" });
    setLike(btn, c.p, Boolean(receipts[c.p.name]), likes[c.p.name].total);
    btn.addEventListener("click", () => toggleLike(btn, note, c.p));
    c.li.querySelector(".head").append(btn, note);
  }
}

function setLike(btn, p, liked, n) {
  n = Math.max(0, n);
  btn.dataset.n = n;
  btn.setAttribute("aria-pressed", String(liked));
  btn.setAttribute("aria-label", `Like ${p.title}, ${n} ${n === 1 ? "like" : "likes"}`);
  btn.querySelector(".like__n").textContent = n;
}

function say(note, text) {
  note.textContent = text;
  note.hidden = !text;
  live.textContent = text;
}

async function toggleLike(btn, note, p) {
  if (btn.getAttribute("aria-busy") === "true") return;
  const receipt = receipts[p.name];
  const liked = Boolean(receipt);
  const before = Number(btn.dataset.n);
  setLike(btn, p, !liked, before + (liked ? -1 : 1)); // show it right away, settle with the server's count
  if (!liked) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  say(note, "");
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await fetch(`/api/likes/${encodeURIComponent(p.name)}`, liked
      ? { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt }) }
      : { method: "POST" });
    const data = await r.json().catch(() => ({}));
    const n = Number.isFinite(data.total) ? data.total : null;
    if (liked && (r.ok || r.status === 404)) { // 404: that like is already gone
      remember(p.name, null);
      setLike(btn, p, false, n ?? before - 1);
    } else if (!liked && r.ok && typeof data.receipt === "string") {
      remember(p.name, data.receipt);
      setLike(btn, p, true, n ?? before + 1);
    } else {
      setLike(btn, p, liked, n ?? before);
      say(note, data.error || "That didn't go through. Try again in a minute.");
    }
  } catch {
    setLike(btn, p, liked, before);
    say(note, "You seem to be offline. Try again when you're connected.");
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

function setupForm() {
  const form = $("suggest-form");
  const text = $("s-text");
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
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const r = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value, project: $("s-project").value || null, website: $("s-website").value }),
      });
      const data = await r.json().catch(() => ({}));
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

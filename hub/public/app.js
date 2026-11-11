// Renders the hub from /data/*.json and runs the suggestion form.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};
const getJson = (path) => fetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

async function render() {
  const [projects, changes, roadmap] = await Promise.all([
    getJson("/data/projects.json"), getJson("/data/changelog.json"), getJson("/data/roadmap.json"),
  ]);

  $("projects").replaceChildren(...projects.map((p) => el("li", {},
    el("article", { className: "card" },
      el("a", { href: p.url, tabIndex: -1, ariaHidden: "true" },
        el("img", { src: p.preview, alt: "", loading: "lazy", width: 960, height: 600 })),
      el("div", { className: "body" },
        el("h3", {}, p.title),
        el("p", {}, p.tagline),
        el("span", { className: "tech" }, (p.tech ?? []).join(", ")),
        el("div", { className: "actions" },
          el("a", { className: "btn primary", href: p.url }, `Play ${p.title}`),
          el("a", { className: "btn", href: `https://github.com/${p.repo}` }, "Source")))))));

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

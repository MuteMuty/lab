// The header: a full-width bar at the top that folds into a floating pill once the page
// moves, as on brightloopapps.com. The pill animates to an exact pixel width (width: auto
// can't transition everywhere), measured from an invisible copy held in the compact state.
// Its highlight slides to the section you're reading, and the bright point travels once
// along the loop over the length of the page.
const nav = document.querySelector(".nav");
const inner = nav?.querySelector(".nav__inner");

if (nav && inner) {
  const links = [...inner.querySelectorAll(".nav__links a")];
  const linkRow = inner.querySelector(".nav__links");
  const glow = inner.querySelector(".nav__glow");
  // Each link's section, plus the suggestion box, which has no link of its own (the
  // button on the right goes there), so reaching it clears the highlight.
  const marks = [
    ...links.map((a) => ({ section: document.querySelector(a.hash), link: a })),
    { section: document.querySelector("#suggest"), link: null },
  ];
  const loop = inner.querySelector(".mark__loop");
  const point = inner.querySelector(".mark__point");
  const loopLength = loop?.getTotalLength?.() ?? 0;

  const ghost = document.createElement("div");
  ghost.className = "nav__ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.append(inner.cloneNode(true));
  nav.append(ghost);

  let active = null;
  const placeGlow = () => {
    if (!active) return;
    glow.style.setProperty("--glow-x", `${active.offsetLeft}px`);
    glow.style.setProperty("--glow-w", `${active.offsetWidth}px`);
  };
  const measure = () => {
    nav.style.setProperty("--pill-w", `${Math.ceil(ghost.firstElementChild.getBoundingClientRect().width)}px`);
    placeGlow();
  };

  const update = () => {
    const compact = scrollY > 24;
    if (compact !== nav.classList.contains("is-compact")) {
      nav.classList.toggle("is-compact", compact);
      measure(); // in case fonts or the viewport changed since the last fold
    }
    const max = document.documentElement.scrollHeight - innerHeight;
    const progress = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    if (loopLength && point) {
      const p = loop.getPointAtLength(progress * loopLength);
      point.setAttribute("cx", p.x.toFixed(2));
      point.setAttribute("cy", p.y.toFixed(2));
    }

    // The section whose top has passed 40% of the way down the screen; the last one
    // once the page can't scroll any further.
    const line = innerHeight * 0.4;
    let next = null;
    for (const m of marks) if (m.section && m.section.getBoundingClientRect().top <= line) next = m.link;
    if (max > 0 && scrollY >= max - 2) next = marks.at(-1).link;
    if (next === active) return;
    active = next;
    for (const a of links) (a === active ? a.setAttribute("aria-current", "location") : a.removeAttribute("aria-current"));
    linkRow.classList.toggle("has-active", Boolean(active));
    placeGlow();
  };

  let queued = false;
  addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  addEventListener("resize", () => { measure(); update(); });
  document.fonts?.ready.then(measure);
  // The project cards and log arrive after load and move the sections down.
  new ResizeObserver(() => update()).observe(document.body);
  measure();
  update();
  // Only animate after the first state is painted, so a reload halfway down doesn't play the fold.
  requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.add("is-ready")));
}

// Hub playtest. Usage: node tests/playtest.ts <baseUrl>
// Against localhost it also submits suggestions (local D1) and checks the daily limit, and likes and
// unlikes a card. Both send from a made-up IP per run, so a rerun on the same day starts with a clear
// suggestion limit and nothing "already liked".
// Against localhost it also checks the privacy note and usage events (lab#71): see the end of the run.
// Env: PLAYTEST_BROWSER, PLAYTEST_OUT.
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Queued } from "../web/analytics/guard.ts"; // and window.labAnalytics
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
if (!base) { console.error("usage: node tests/playtest.ts <baseUrl>"); process.exit(2); }
const local = /localhost|127\.0\.0\.1/.test(base);
const out = process.env.PLAYTEST_OUT || join(dirname(fileURLToPath(import.meta.url)), "..", "playtest-out");
mkdirSync(out, { recursive: true });
declare global { interface Window { __stale?: boolean } } // set by the two-tab check below

const failures = [];
const fail = (m) => failures.push(m);

// The cards show likes only when the API has them. Checks hearts, names, counts, order and the label.
const checkLikes = (page) => page.evaluate(async () => {
  const projects = await (await fetch("/data/projects.json")).json();
  const r = await fetch("/api/likes?quiet=1"); // quiet: 204, not a 503 console error, before migration 0002
  const likes = r.status === 200 ? await r.json() : null;
  const cards = [...document.querySelectorAll(".card")];
  const problems = [];
  if (!likes) {
    if (document.querySelector(".card .like, .card .top")) problems.push("hearts shown without like counts");
    const want = projects.map((p) => p.title).join(", ");
    const have = cards.map((c) => c.querySelector("h3").textContent).join(", ");
    if (want !== have) problems.push(`card order changed without like counts: ${have}`);
    return { available: false, problems };
  }
  const week = (p) => likes[p.name]?.week ?? 0;
  const order = projects.map((p, i) => ({ p, i }))
    .sort((a, b) => week(b.p) - week(a.p) || (b.p.launched ?? "").localeCompare(a.p.launched ?? "") || a.i - b.i)
    .map(({ p }) => p);
  const have = cards.map((c) => c.querySelector("h3").textContent);
  if (have.join() !== order.map((p) => p.title).join()) problems.push(`cards not ordered by likes this week: ${have.join(", ")}`);
  const topWanted = order[0] && week(order[0]) > 0 && (!order[1] || week(order[0]) > week(order[1]));
  const labels = cards.filter((c) => c.querySelector(".top")).map((c) => c.querySelector("h3").textContent);
  if (labels.join() !== (topWanted ? order[0].title : "")) problems.push(`"Most liked" on [${labels.join(", ")}]`);
  for (const p of projects) {
    const card = cards.find((c) => c.querySelector("h3").textContent === p.title);
    const btn = card?.querySelector("button.like");
    if (!btn) { problems.push(`${p.title}: no like button`); continue; }
    if (btn.getAttribute("aria-label") !== `Like ${p.title}`) problems.push(`${p.title}: like button is named "${btn.getAttribute("aria-label")}"`);
    const desc = document.getElementById(btn.getAttribute("aria-describedby"))?.textContent;
    if (!desc?.startsWith(`${likes[p.name]?.total} like`)) problems.push(`${p.title}: like button described as "${desc}"`);
    if (!["true", "false"].includes(btn.getAttribute("aria-pressed"))) problems.push(`${p.title}: like button has no pressed state`);
    if (btn.querySelector(".like__n").textContent !== String(likes[p.name]?.total)) problems.push(`${p.title}: shows ${btn.textContent}, API says ${likes[p.name]?.total}`);
  }
  return { available: true, problems };
});

// Usage events: what analytics may leave in the browser (nothing) and the hosts it may talk to.
const LAB_KEYS = ["lab:likes"]; // the like receipts, the only thing the lab itself keeps in the browser
const isPosthog = (url: string) => /(^|\.)posthog\.com$/.test(new URL(url).hostname);
const leftovers = async (page) => {
  const kept = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  const cookies = await page.context().cookies();
  return [
    ...kept.local.filter((k) => !LAB_KEYS.includes(k)).map((k) => `localStorage "${k}"`),
    ...kept.session.map((k) => `sessionStorage "${k}"`),
    ...cookies.map((c) => `cookie "${c.name}" on ${c.domain}`),
  ];
};
// The shared script must start only after the page has loaded.
const analyticsTiming = (page) => page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
  const s = performance.getEntriesByType("resource").find((e) => e.name.endsWith("/analytics/v1.js"));
  return { loaded: nav?.loadEventEnd ?? 0, started: s ? s.startTime : null };
});
const waitForAnalytics = (page) => page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => e.name.endsWith("/analytics/v1.js")), null, { timeout: 8000 });
// Whether the browser asks sites not to track it. Brave sends Global Privacy Control by default, so every check
// that loads the hub sets both signals to what it means to test: by default, neither.
const privacySignals = (target: { addInitScript: Page["addInitScript"] }, { dnt = null, gpc = false }: { dnt?: string | null; gpc?: boolean } = {}) =>
  target.addInitScript(([dnt, gpc]) => {
    Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => dnt, configurable: true });
    Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => gpc, configurable: true });
  }, [dnt, gpc] as const);

let likesSeen = false;
const browser = await chromium.launch({ executablePath: process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
try {
  for (const [name, viewport, colorScheme] of [["desktop-dark", { width: 1280, height: 900 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"]] as const) {
    const page = await browser.newPage({ viewport, colorScheme });
    await privacySignals(page);
    page.on("console", (m) => m.type() === "error" && !/status of 429/.test(m.text()) && fail(`${name}: console error: ${m.text()}`));
    page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
    page.on("request", (r) => isPosthog(r.url()) && fail(`${name}: analytics contacted ${r.url()} from ${base}`));
    if (!(await page.goto(base, { waitUntil: "networkidle" }).catch((e) => fail(`${name}: load failed: ${e.message}`)))) { await page.close(); continue; }
    if (!(await page.waitForSelector(".card h3", { timeout: 5000 }).catch(() => null))) fail(`${name}: no project cards`);
    else if (!(await page.$$eval(".card h3", (hs) => hs.some((h) => h.textContent.includes("Afterstep"))))) fail(`${name}: Afterstep card missing`);
    // Every project in the data gets a card whose preview actually loads.
    const cards = await page.evaluate(async () => {
      const want = (await (await fetch("/data/projects.json")).json()).map((p) => p.title);
      await Promise.all([...document.querySelectorAll<HTMLImageElement>(".card img")].map((i) => i.decode().catch(() => {})));
      const have = [...document.querySelectorAll(".card")].map((c) => ({ title: c.querySelector("h3").textContent, img: c.querySelector("img").naturalWidth }));
      return { want, have };
    });
    for (const t of cards.want) {
      const c = cards.have.find((h) => h.title === t);
      if (!c) fail(`${name}: ${t} card missing`);
      else if (!c.img) fail(`${name}: ${t} preview didn't load`);
    }
    if (local) await page.waitForSelector(".card .like", { timeout: 5000 }).catch(() => fail(`${name}: no like buttons on localhost`));
    const likes = await checkLikes(page);
    for (const p of likes.problems) fail(`${name}: ${p}`);
    if (!likes.available) console.log(`${name}: like counts unavailable, cards shown as before`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) fail(`${name}: horizontal scroll at ${viewport.width}px`);
    if (!(await page.$('.foot a[href="/privacy"]'))) fail(`${name}: the footer doesn't link the privacy note`);
    await page.screenshot({ path: join(out, `${name}-hub.png`), fullPage: true });

    // The header folds into a pill on scroll; everything in it must sit inside the pill.
    await page.evaluate(() => scrollTo(0, 600));
    await page.waitForTimeout(1000); // the fold animates for 650 ms
    const pill = await page.evaluate(() => {
      const inner = document.querySelector(".nav > .nav__inner");
      const box = inner.getBoundingClientRect();
      const out = [...inner.querySelectorAll(".wordmark, .nav__links a, .nav__cta")]
        .filter((el) => getComputedStyle(el).display !== "none")
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.left < box.left - 0.5 || r.right > box.right - 2 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
        .map(({ el, r }) => `${el.textContent.trim() || el.className} [${Math.round(r.left)}–${Math.round(r.right)}] outside the pill [${Math.round(box.left)}–${Math.round(box.right)}]`);
      return { compact: document.querySelector(".nav").classList.contains("is-compact"), out, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    if (!pill.compact) fail(`${name}: header didn't fold into a pill after scrolling`);
    for (const o of pill.out) fail(`${name}: ${o}`);
    if (pill.overflowX) fail(`${name}: horizontal scroll with the pill`);
    await page.screenshot({ path: join(out, `${name}-pill.png`), clip: { x: 0, y: 0, width: viewport.width, height: 110 } });
    await page.evaluate(() => scrollTo(0, 0));

    // Like a card, reload (it stays liked), then unlike it with the keyboard.
    if (local && likes.available) {
      const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      await page.route("**/api/likes/*", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }));
      const title = await page.textContent(".card h3");
      const btn = page.locator(".card", { has: page.locator("h3", { hasText: title }) }).locator("button.like");
      const state = async () => ({ pressed: await btn.getAttribute("aria-pressed"), n: Number(await btn.locator(".like__n").textContent()) });
      const settled = () => page.waitForFunction(() => ![...document.querySelectorAll("button.like")].some((b) => b.hasAttribute("aria-busy")));
      const stored = () => page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem("lab:likes")) ?? {}); } catch { return []; } });
      const said = () => page.textContent(".sr-only[role=status]");
      const start = await state();
      if (start.pressed !== "false") fail(`${name}: ${title} starts liked in a fresh browser`);
      await btn.click();
      await settled();
      const liked = await state();
      if (liked.pressed !== "true" || liked.n !== start.n + 1) fail(`${name}: liking ${title} gave ${JSON.stringify(liked)} from ${JSON.stringify(start)}`);
      if ((await said()) !== `Liked ${title}`) fail(`${name}: liking announced "${await said()}"`);
      if ((await btn.getAttribute("aria-label")) !== `Like ${title}`) fail(`${name}: like button renamed to "${await btn.getAttribute("aria-label")}"`);
      if ((await stored()).length !== 1) fail(`${name}: the like's receipt wasn't remembered`);
      await page.reload({ waitUntil: "networkidle" });
      await btn.waitFor({ timeout: 5000 }).catch(() => fail(`${name}: like button missing after reload`));
      const again = await state();
      if (again.pressed !== "true" || again.n !== start.n + 1) fail(`${name}: after reload ${title} shows ${JSON.stringify(again)}`);
      for (const p of (await checkLikes(page)).problems) fail(`${name} (liked): ${p}`);
      await page.screenshot({ path: join(out, `${name}-liked.png`), fullPage: true });
      await btn.focus();
      await page.keyboard.press(name.startsWith("phone") ? "Space" : "Enter");
      await settled();
      const unliked = await state();
      if (unliked.pressed !== "false" || unliked.n !== start.n) fail(`${name}: unliking ${title} with the keyboard gave ${JSON.stringify(unliked)}`);
      if ((await said()) !== `Unliked ${title}`) fail(`${name}: unliking announced "${await said()}"`);
      if ((await stored()).length !== 0) fail(`${name}: the receipt wasn't forgotten after unliking`);
      if (await page.locator(".like-note:not([hidden])").count()) fail(`${name}: like error shown: ${await page.textContent(".like-note:not([hidden])")}`);
      console.log(`${name}: liked and unliked ${title} (${start.n} → ${liked.n} → ${unliked.n})`);
      await page.unroute("**/api/likes/*");
    }

    // Too-short input is caught in the browser.
    await page.fill("#s-text", "x");
    await page.click("#suggest-form button");
    if (!(await page.textContent("#s-status")).includes("at least")) fail(`${name}: short suggestion not caught`);

    if (local && name === "desktop-dark") {
      // A fresh made-up IP per run: the limit counts per IP hash over 24 hours in the local D1, which keeps
      // earlier runs' rows, so a shared IP would hit the limit at once on a second run the same day.
      const ip = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      await page.route("**/api/suggest", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }));
      let sent = 0, limited = false;
      for (let i = 0; i < 7 && !limited; i++) {
        await page.fill("#s-text", `playtest idea number ${i} ${Date.now()}`);
        await page.click("#suggest-form button");
        await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#suggest-form button").disabled);
        const s = await page.textContent("#s-status");
        if (s.startsWith("Sent")) sent++;
        else if (s.includes("plenty")) limited = true;
        else fail(`${name}: unexpected status "${s}"`);
      }
      if (sent === 0) fail(`${name}: no suggestion was accepted before the daily limit`);
      if (!limited) fail(`${name}: daily limit never kicked in`);
      await page.unroute("**/api/suggest");
      await page.screenshot({ path: join(out, `${name}-suggest.png`) });
      console.log(`${name}: ${sent} sent before the limit`);
    }
    // The shared analytics script arrives after the page has loaded, and here it's a no-op.
    if (!(await waitForAnalytics(page).catch(() => null))) fail(`${name}: /analytics/v1.js never loaded`);
    else {
      const t = await analyticsTiming(page);
      if (t.started < t.loaded) fail(`${name}: analytics started at ${Math.round(t.started)} ms, before the page loaded at ${Math.round(t.loaded)} ms`);
    }
    for (const l of await leftovers(page)) fail(`${name}: analytics left ${l}`);
    await page.close();
    if (likes.available) likesSeen = true;
  }

  // Two tabs share one browser's receipts. Tab 2 first plays a stale tab (it ignores storage events), and its
  // like must not drop tab 1's receipt. Then both listen, and an unlike in one shows up in the other.
  if (local && likesSeen) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    await ctx.route("**/api/likes/*", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }));
    const t1 = await ctx.newPage(), t2 = await ctx.newPage();
    await t2.addInitScript(() => {
      window.__stale = true;
      addEventListener("storage", (e) => window.__stale && e.stopImmediatePropagation(), true);
    });
    for (const [n, t] of [["tab 1", t1], ["tab 2", t2]] as const) {
      t.on("console", (m) => m.type() === "error" && fail(`two tabs, ${n}: console error: ${m.text()}`));
      t.on("pageerror", (e) => fail(`two tabs, ${n}: page error: ${e.message}`));
      await t.goto(base, { waitUntil: "networkidle" });
      await t.waitForSelector(".card .like", { timeout: 5000 }).catch(() => fail(`two tabs, ${n}: no like buttons`));
    }
    const [a, b] = await t1.$$eval(".card h3", (hs) => hs.map((h) => h.textContent));
    const btn = (t, title) => t.locator(".card", { has: t.locator("h3", { hasText: title }) }).locator("button.like");
    const settled = (t) => t.waitForFunction(() => ![...document.querySelectorAll("button.like")].some((x) => x.hasAttribute("aria-busy")));
    const pressed = (t, title) => btn(t, title).getAttribute("aria-pressed");
    const count = async (t, title) => Number(await btn(t, title).locator(".like__n").textContent());
    const stored = () => t1.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("lab:likes")) ?? {}).sort().join(", "));
    const press = async (t, title) => { await btn(t, title).click(); await settled(t); };
    if (!b) fail("two tabs: need two cards");
    else {
      const startA = await count(t1, a), startB = await count(t1, b);
      await press(t1, a);
      await press(t2, b); // stale: tab 2 still thinks nothing is liked
      const names = await t1.evaluate(async () => Object.fromEntries((await (await fetch("/data/projects.json")).json()).map((p) => [p.title, p.name])));
      const want = [names[a], names[b]].sort().join(", ");
      if ((await stored()) !== want) fail(`two tabs: stored receipts are [${await stored()}], want [${want}]`);
      for (const t of [t1, t2]) await t.reload({ waitUntil: "networkidle" });
      await t2.evaluate(() => { window.__stale = false; });
      for (const [n, t] of [["tab 1", t1], ["tab 2", t2]] as const) {
        await btn(t, b).waitFor({ timeout: 5000 }).catch(() => {});
        for (const title of [a, b]) if ((await pressed(t, title)) !== "true") fail(`two tabs, ${n}: ${title} not liked after reload`);
      }
      await press(t1, a);
      await t2.waitForFunction((title) => [...document.querySelectorAll(".card")].find((c) => c.querySelector("h3").textContent === title)
        ?.querySelector("button.like").getAttribute("aria-pressed") === "false", a, { timeout: 3000 })
        .catch(() => fail(`two tabs: unliking ${a} in tab 1 didn't show in tab 2`));
      if ((await count(t2, a)) !== startA) fail(`two tabs: tab 2 shows ${a} at ${await count(t2, a)}, want ${startA}`);
      await press(t2, b);
      await t1.waitForFunction((title) => [...document.querySelectorAll(".card")].find((c) => c.querySelector("h3").textContent === title)
        ?.querySelector("button.like").getAttribute("aria-pressed") === "false", b, { timeout: 3000 })
        .catch(() => fail(`two tabs: unliking ${b} in tab 2 didn't show in tab 1`));
      if ((await count(t1, b)) !== startB) fail(`two tabs: tab 1 shows ${b} at ${await count(t1, b)}, want ${startB}`);
      if ((await stored()) !== "") fail(`two tabs: receipts left after unliking both: [${await stored()}]`);
      for (const [n, t] of [["tab 1", t1], ["tab 2", t2]] as const) {
        if (await t.locator(".like-note:not([hidden])").count()) fail(`two tabs, ${n}: like error shown: ${await t.textContent(".like-note:not([hidden])")}`);
        for (const p of (await checkLikes(t)).problems) fail(`two tabs, ${n}: ${p}`);
      }
      console.log(`two tabs: liked ${a} and ${b} from separate tabs, both kept, both unliked, each tab saw the other's change`);
    }
    await ctx.close();
  }

  // The privacy note: the hub's look in light and dark, on phone and desktop, with the same footer.
  for (const [name, viewport, colorScheme] of [
    ["desktop-dark", { width: 1280, height: 900 }, "dark"], ["desktop-light", { width: 1280, height: 900 }, "light"],
    ["phone-dark", { width: 390, height: 844 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"],
    ["small-phone-light", { width: 320, height: 640 }, "light"],
  ] as const) {
    const page = await browser.newPage({ viewport, colorScheme });
    page.on("console", (m) => m.type() === "error" && fail(`privacy ${name}: console error: ${m.text()}`));
    page.on("pageerror", (e) => fail(`privacy ${name}: page error: ${e.message}`));
    const r = await page.goto(new URL("/privacy", base).href, { waitUntil: "networkidle" }).catch((e) => { fail(`privacy ${name}: load failed: ${e.message}`); return null; });
    if (!r) { await page.close(); continue; }
    if (!r.ok()) fail(`privacy ${name}: /privacy answered ${r.status()}`);
    const p = await page.evaluate(() => ({
      h1: document.querySelector("h1")?.textContent,
      text: document.querySelector("main")?.textContent.replace(/\s+/g, " ") ?? "",
      foot: document.querySelector(".foot")?.textContent.replace(/\s+/g, " ").trim(),
      erik: document.querySelector<HTMLAnchorElement>('.foot a[href="https://github.com/MuteMuty"]')?.textContent,
      privacy: Boolean(document.querySelector('.foot a[href="/privacy"]')),
      home: Boolean(document.querySelector('.nav a.wordmark[href="/"]')),
      font: getComputedStyle(document.querySelector("h1")).fontFamily,
      bg: getComputedStyle(document.body).backgroundImage !== "none",
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      clipped: [...document.querySelectorAll(".nav .wordmark, .nav .nav__cta")].filter((e) => e.getBoundingClientRect().right > innerWidth).map((e) => e.textContent.trim()),
      scripts: document.scripts.length,
    }));
    if (p.h1 !== "Privacy") fail(`privacy ${name}: heading is "${p.h1}"`);
    for (const must of ["Likes", "Page views", "Projects opened", "front page", "No cookies", "EU", "IP address", "Do Not Track", "Global Privacy Control", "Anything you type, draw, record or upload"]) {
      if (!p.text.includes(must)) fail(`privacy ${name}: doesn't mention "${must}"`);
    }
    if (!p.foot?.startsWith("Made by Erik Pahor at BrightLoop Lab") || p.erik !== "Erik Pahor" || !p.privacy) fail(`privacy ${name}: footer is "${p.foot}"`);
    if (!p.home) fail(`privacy ${name}: no way back to the hub`);
    if (!p.font.includes("Bricolage")) fail(`privacy ${name}: heading font is ${p.font}`);
    if (!p.bg) fail(`privacy ${name}: page background missing`);
    if (p.overflowX) fail(`privacy ${name}: horizontal scroll at ${viewport.width}px`);
    for (const c of p.clipped) fail(`privacy ${name}: "${c}" runs past the edge at ${viewport.width}px`);
    if (p.scripts) fail(`privacy ${name}: runs ${p.scripts} script(s); it needs none`);
    for (const l of await leftovers(page)) fail(`privacy ${name}: left ${l}`);
    await page.screenshot({ path: join(out, `${name}-privacy.png`), fullPage: true });
    await page.close();
  }

  // Usage events (lab#71). Analytics only sends on *.brightloopapps.com, so the hub is served under made-up
  // hostnames: every request to one is answered by the local server, and PostHog's endpoint is answered here,
  // so nothing reaches PostHog and the project cards open a stub. The browser also has to look like a
  // person's, since posthog skips automated browsers.
  if (local) {
    const projects: { name: string; title: string; url: string }[] = await (await fetch(new URL("/data/projects.json", base))).json();
    const known = projects.map((p) => p.name);
    const projectHosts = projects.map((p) => new URL(p.url).hostname);
    const probe = await browser.newPage();
    const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
    await probe.close();
    const decode = (body: Buffer | null) => {
      if (!body?.length) return [];
      let text = body[0] === 0x1f ? gunzipSync(body).toString() : body.toString();
      if (text.startsWith("data=")) text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString();
      const v = JSON.parse(text);
      return Array.isArray(v) ? v : v.batch ?? [v];
    };
    // With `signals` (Do Not Track or Global Privacy Control), the hub mustn't even fetch the script; it's then
    // added by hand as another project might, and must stay quiet too.
    const run = async (label: string, host: string, { posthogUp = true, click = false, signals = undefined as Parameters<typeof privacySignals>[1] } = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", userAgent });
      await ctx.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
        Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
      });
      await privacySignals(ctx, signals);
      const hosts = new Set<string>();
      const events = [];
      await ctx.route((u) => u.hostname === host, async (route) => {
        const u = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: new URL(u.pathname + u.search, base).href }) });
      });
      await ctx.route((u) => projectHosts.includes(u.hostname), (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub</title>" }));
      await ctx.route((u) => /(^|\.)posthog\.com$/.test(u.hostname), async (route) => {
        const req = route.request();
        if (new URL(req.url()).hostname !== "eu.i.posthog.com") { fail(`${label}: analytics contacted ${req.url()}`); return route.abort(); }
        if (!posthogUp) return route.abort();
        try { events.push(...decode(req.postDataBuffer()).map((e) => ({ ...e, by: req.resourceType() }))); } catch (e) { fail(`${label}: couldn't read what analytics sent to ${req.url()}: ${e.message}`); }
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"Ok"}' });
      });
      const page = await ctx.newPage();
      page.on("request", (r) => hosts.add(new URL(r.url()).hostname));
      // A blocked request shows up as the browser's own network line; anything else is ours.
      page.on("console", (m) => m.type() === "error" && !(!posthogUp && /Failed to load resource/.test(m.text())) && fail(`${label}: console error: ${m.text()}`));
      page.on("pageerror", (e) => fail(`${label}: page error: ${e.message}`));
      await page.goto(`https://${host}/`, { waitUntil: "networkidle" });
      await page.waitForSelector(".card h3", { timeout: 5000 }).catch(() => fail(`${label}: no project cards`));
      if (!signals) {
        if (!(await waitForAnalytics(page).catch(() => null))) fail(`${label}: /analytics/v1.js never loaded`);
      } else {
        await page.waitForTimeout(3500); // past load.ts's idle timeout, when the script would have been added
        if (await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.endsWith("/analytics/v1.js")))) fail(`${label}: the hub fetched /analytics/v1.js`);
        await page.evaluate(async (known) => {
          window.labAnalytics = { project: "hub", allow: { $pageview: {}, project_opened: { project: known } }, queue: [["project_opened", { project: known[0] }] as Queued] };
          await new Promise((done) => document.head.append(Object.assign(document.createElement("script"), { src: "/analytics/v1.js", onload: done, onerror: done })));
          window.labAnalytics.queue.push(["project_opened", { project: known[1] ?? known[0] }]);
        }, known);
      }
      await page.waitForTimeout(1500); // posthog starts and sends the pageview
      for (const l of await leftovers(page)) fail(`${label}: analytics left ${l}`);
      let opened = null;
      if (click) {
        const card = page.locator(".card").first();
        const title = await card.locator("h3").textContent();
        opened = projects.find((p) => p.title === title)?.name;
        // 14 quick clicks held back from navigating, then one that goes: still one project_opened.
        await page.evaluate(() => {
          const hold = (e: Event) => e.preventDefault();
          addEventListener("click", hold);
          for (let i = 0; i < 14; i++) document.querySelector<HTMLAnchorElement>(".card .btn.primary").click();
          removeEventListener("click", hold);
        });
        await Promise.all([page.waitForURL((u) => projectHosts.includes(u.hostname)), card.locator(".btn.primary").click()]);
        await page.waitForTimeout(1000);
        for (const l of (await ctx.cookies()).map((c) => `cookie "${c.name}" on ${c.domain}`)) fail(`${label}: analytics left ${l}`);
      }
      const allowedHosts = new Set([host, ...(signals ? [] : ["eu.i.posthog.com"]), "fonts.googleapis.com", "fonts.gstatic.com", ...projectHosts]);
      for (const h of hosts) if (!allowedHosts.has(h)) fail(`${label}: the page contacted ${h}`);
      await ctx.close();
      return { events, opened };
    };

    // Production: a pageview, then project_opened for the card followed, and nothing else.
    const prod = await run("production", "lab.playtest.brightloopapps.com", { click: true });
    const names = prod.events.map((e) => e.event);
    if (names.join() !== "$pageview,project_opened") fail(`production: analytics sent [${names.join(", ")}], want [$pageview, project_opened]`);
    for (const e of prod.events) {
      const extra = Object.keys(e.properties ?? {}).filter((k) => !k.startsWith("$") && !["token", "distinct_id", "project"].includes(k));
      if (extra.length) fail(`production: ${e.event} carried ${extra.join(", ")}`);
      if (e.$set || e.$set_once || e.properties?.$set || e.properties?.$set_once) fail(`production: ${e.event} set person properties`);
      if (e.properties?.$current_url && /[?#]/.test(e.properties.$current_url)) fail(`production: ${e.event} sent ${e.properties.$current_url}`);
    }
    const pv = prod.events.find((e) => e.event === "$pageview");
    if (pv && pv.properties?.project !== "hub") fail(`production: $pageview project is ${pv.properties?.project}`);
    const po = prod.events.find((e) => e.event === "project_opened");
    if (po && (po.properties?.project !== prod.opened || !known.includes(po.properties?.project))) fail(`production: project_opened for ${po.properties?.project}, followed ${prod.opened}`);
    if (prod.events[0] && prod.events[0].properties?.$cookieless_mode !== true) fail("production: events aren't marked cookieless");
    if (po && po.by !== "ping") fail(`production: project_opened went by ${po.by}, not a beacon that outlives the page`);
    console.log(`production: analytics sent ${names.join(", ")} (${prod.opened}, 15 clicks, ${po?.by}), no cookies or storage`);

    // The visitor asked not to be tracked: nothing is sent, and PostHog is never contacted.
    for (const [label, signals] of [["do not track", { dnt: "1" }], ["global privacy control", { gpc: true }]] as const) {
      const quiet = await run(label, "lab.playtest.brightloopapps.com", { click: true, signals });
      if (quiet.events.length) fail(`${label}: analytics sent ${quiet.events.map((e) => e.event).join(", ")}`);
    }

    // PostHog unreachable (an ad blocker, say): the page carries on and nothing shows.
    await run("posthog blocked", "lab.playtest.brightloopapps.com", { posthogUp: false });
    // A workers.dev preview: the script loads and sends nothing.
    const preview = await run("workers.dev", "lab-hub.playtest.workers.dev", { click: true });
    if (preview.events.length) fail(`workers.dev: analytics sent ${preview.events.map((e) => e.event).join(", ")}`);

    // The script itself blocked: the hub still works and stays quiet.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await privacySignals(page);
    await page.route("**/analytics/v1.js", (route) => route.abort("blockedbyclient"));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && fail(`script blocked: console error: ${m.text()}`));
    page.on("pageerror", (e) => fail(`script blocked: page error: ${e.message}`));
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".card h3", { timeout: 5000 }).catch(() => fail("script blocked: no project cards"));
    await page.waitForTimeout(1500);
    // Following a card still works, and the event just waits in the queue (navigation is held back here).
    const queued = await page.evaluate(() => {
      addEventListener("click", (e) => e.preventDefault());
      document.querySelector<HTMLAnchorElement>(".card a[data-open]")?.click();
      const q = window.labAnalytics?.queue;
      return Array.isArray(q) ? q.length : -1;
    });
    if (queued !== 1) fail(`script blocked: following a card queued ${queued} events, want 1`);
    await page.close();
    console.log("analytics: no-op on localhost, workers.dev and with Do Not Track or GPC, harmless when blocked");
  }
} finally {
  await browser.close();
}
if (failures.length) { console.error("PLAYTEST FAIL\n- " + failures.join("\n- ")); process.exit(1); }
console.log(`PLAYTEST PASS (screenshots in ${out})`);

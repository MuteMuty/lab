// Hub playtest. Usage: node tests/playtest.mjs <baseUrl>
// Against localhost it also submits suggestions (local D1) and checks the daily limit, and likes and
// unlikes a card (from a made-up IP per run, so a rerun on the same day isn't "already liked").
// Env: PLAYTEST_BROWSER, PLAYTEST_OUT.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
if (!base) { console.error("usage: node tests/playtest.mjs <baseUrl>"); process.exit(2); }
const local = /localhost|127\.0\.0\.1/.test(base);
const out = process.env.PLAYTEST_OUT || join(dirname(fileURLToPath(import.meta.url)), "..", "playtest-out");
mkdirSync(out, { recursive: true });
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
    if (!btn.getAttribute("aria-label")?.startsWith(`Like ${p.title}`)) problems.push(`${p.title}: like button has no name`);
    if (!["true", "false"].includes(btn.getAttribute("aria-pressed"))) problems.push(`${p.title}: like button has no pressed state`);
    if (btn.querySelector(".like__n").textContent !== String(likes[p.name]?.total)) problems.push(`${p.title}: shows ${btn.textContent}, API says ${likes[p.name]?.total}`);
  }
  return { available: true, problems };
});

const browser = await chromium.launch({ executablePath: process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
try {
  for (const [name, viewport, colorScheme] of [["desktop-dark", { width: 1280, height: 900 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"]]) {
    const page = await browser.newPage({ viewport, colorScheme });
    page.on("console", (m) => m.type() === "error" && !/status of 429/.test(m.text()) && fail(`${name}: console error: ${m.text()}`));
    page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
    if (!(await page.goto(base, { waitUntil: "networkidle" }).catch((e) => fail(`${name}: load failed: ${e.message}`)))) { await page.close(); continue; }
    if (!(await page.waitForSelector(".card h3", { timeout: 5000 }).catch(() => null))) fail(`${name}: no project cards`);
    else if (!(await page.$$eval(".card h3", (hs) => hs.some((h) => h.textContent.includes("Afterstep"))))) fail(`${name}: Afterstep card missing`);
    // Every project in the data gets a card whose preview actually loads.
    const cards = await page.evaluate(async () => {
      const want = (await (await fetch("/data/projects.json")).json()).map((p) => p.title);
      await Promise.all([...document.querySelectorAll(".card img")].map((i) => i.decode().catch(() => {})));
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
      const start = await state();
      if (start.pressed !== "false") fail(`${name}: ${title} starts liked in a fresh browser`);
      await btn.click();
      await settled();
      const liked = await state();
      if (liked.pressed !== "true" || liked.n !== start.n + 1) fail(`${name}: liking ${title} gave ${JSON.stringify(liked)} from ${JSON.stringify(start)}`);
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
      let sent = 0, limited = false;
      for (let i = 0; i < 7 && !limited; i++) {
        await page.fill("#s-text", `playtest idea number ${i} ${Date.now()}`);
        await page.click("#suggest-form button");
        await page.waitForFunction(() => !document.querySelector("#suggest-form button").disabled);
        const s = await page.textContent("#s-status");
        if (s.startsWith("Sent")) sent++;
        else if (s.includes("plenty")) limited = true;
        else fail(`${name}: unexpected status "${s}"`);
      }
      if (!limited) fail(`${name}: daily limit never kicked in`);
      if (sent === 0 && !limited) fail(`${name}: no suggestion was accepted`);
      await page.screenshot({ path: join(out, `${name}-suggest.png`) });
      console.log(`${name}: ${sent} sent before the limit`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.error("PLAYTEST FAIL\n- " + failures.join("\n- ")); process.exit(1); }
console.log(`PLAYTEST PASS (screenshots in ${out})`);

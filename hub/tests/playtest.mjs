// Hub playtest. Usage: node tests/playtest.mjs <baseUrl>
// Against localhost it also submits suggestions (local D1) and checks the daily limit.
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

const browser = await chromium.launch({ executablePath: process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" });
try {
  for (const [name, viewport, colorScheme] of [["desktop-dark", { width: 1280, height: 900 }, "dark"], ["phone-light", { width: 390, height: 844 }, "light"]]) {
    const page = await browser.newPage({ viewport, colorScheme });
    page.on("console", (m) => m.type() === "error" && !/status of 429/.test(m.text()) && fail(`${name}: console error: ${m.text()}`));
    page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
    if (!(await page.goto(base, { waitUntil: "networkidle" }).catch((e) => fail(`${name}: load failed: ${e.message}`)))) { await page.close(); continue; }
    if (!(await page.waitForSelector(".card h3", { timeout: 5000 }).catch(() => null))) fail(`${name}: no project cards`);
    else if (!(await page.textContent(".card h3")).includes("Afterstep")) fail(`${name}: Afterstep card missing`);
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

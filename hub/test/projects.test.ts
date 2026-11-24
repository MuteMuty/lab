import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { action, cta } from "../web/projects.ts";

test("a card's button says Play unless the project names its own verb", () => {
  assert.equal(action({ title: "Afterstep" }), "Play");
  assert.equal(cta({ title: "Afterstep" }), "Play Afterstep");
  assert.equal(action({ title: "Sayfold", action: "Try" }), "Try");
  assert.equal(cta({ title: "Sayfold", action: "Try" }), "Try Sayfold");
});

test("a blank or padded verb falls back to Play or is trimmed", () => {
  assert.equal(cta({ title: "Inkchime", action: "" }), "Play Inkchime");
  assert.equal(cta({ title: "Inkchime", action: "   " }), "Play Inkchime");
  assert.equal(cta({ title: "Sayfold", action: " Try " }), "Try Sayfold");
});

test("the games say Play and Sayfold, a tool, says Try", () => {
  const projects: { name: string; title: string; action?: string }[] = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
  const by = Object.fromEntries(projects.map((p) => [p.name, cta(p)]));
  assert.equal(by.afterstep, "Play Afterstep");
  assert.equal(by.inkchime, "Play Inkchime");
  assert.equal(by.sayfold, "Try Sayfold");
});

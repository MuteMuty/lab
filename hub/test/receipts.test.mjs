import { test } from "node:test";
import assert from "node:assert/strict";
import { STORE, readReceipts, saveReceipt, flipped } from "../public/receipts.js";

// A tiny localStorage stand-in. Two "tabs" share one of these, just like two tabs share one origin's storage.
const storage = (init) => {
  const m = new Map(init === undefined ? [] : [[STORE, init]]);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: () => m.get(STORE) };
};
const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
const A = "a".repeat(32), B = "b".repeat(32);

test("reads receipts, ignoring junk", () => {
  assert.deepEqual(readReceipts(storage()), {});
  assert.deepEqual(readReceipts(storage("not json")), {});
  assert.deepEqual(readReceipts(storage("[1,2]")), {});
  assert.deepEqual(readReceipts(storage("null")), {});
  assert.deepEqual(readReceipts(storage(JSON.stringify({ inkchime: A, afterstep: 5, juryloop: null }))), { inkchime: A });
});

test("drops receipts that aren't 32 lowercase hex characters, so the card can be liked again", () => {
  const junk = { inkchime: "zzz", afterstep: A.toUpperCase(), juryloop: `${A}0`, rallyform: "", wordwell: B };
  const shared = storage(JSON.stringify(junk));
  assert.deepEqual(readReceipts(shared), { wordwell: B });
  // Liking again replaces the hand-edited receipt and the next write clears the rest.
  assert.deepEqual(saveReceipt(shared, "inkchime", A, readReceipts(shared)), { wordwell: B, inkchime: A });
  assert.deepEqual(JSON.parse(shared.raw()), { wordwell: B, inkchime: A });
});

test("a stale tab's like keeps the other tab's receipt", () => {
  const shared = storage();
  const tab2 = readReceipts(shared); // tab 2 loads first and never hears about tab 1
  saveReceipt(shared, "inkchime", A, readReceipts(shared)); // tab 1 likes Inkchime
  const after = saveReceipt(shared, "afterstep", B, tab2); // stale tab 2 likes Afterstep
  assert.deepEqual(after, { inkchime: A, afterstep: B });
  assert.deepEqual(JSON.parse(shared.raw()), { inkchime: A, afterstep: B });
});

test("a stale tab's unlike only forgets its own receipt", () => {
  const shared = storage(JSON.stringify({ afterstep: B }));
  const tab2 = readReceipts(shared);
  saveReceipt(shared, "inkchime", A, readReceipts(shared)); // tab 1 likes Inkchime
  assert.deepEqual(saveReceipt(shared, "afterstep", null, tab2), { inkchime: A });
  assert.deepEqual(JSON.parse(shared.raw()), { inkchime: A });
});

test("without storage it keeps receipts for this page only", () => {
  assert.deepEqual(readReceipts(broken), {});
  assert.deepEqual(readReceipts(null, { inkchime: A }), { inkchime: A });
  let mem = saveReceipt(broken, "inkchime", A, {});
  assert.deepEqual(mem, { inkchime: A });
  mem = saveReceipt(broken, "afterstep", B, mem);
  assert.deepEqual(mem, { inkchime: A, afterstep: B });
  assert.deepEqual(saveReceipt(null, "inkchime", null, mem), { afterstep: B });
});

test("flipped names the projects whose liked state changed", () => {
  assert.deepEqual(flipped({ inkchime: A }, { inkchime: A, afterstep: B }), ["afterstep"]);
  assert.deepEqual(flipped({ inkchime: A, afterstep: B }, {}).sort(), ["afterstep", "inkchime"]);
  assert.deepEqual(flipped({ inkchime: A }, { inkchime: B }), []); // a new receipt, still liked
});

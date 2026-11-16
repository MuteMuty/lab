// Like receipts kept in this browser, so it can take a like back. Every open tab shares them,
// so each write re-reads storage and merges, instead of saving a tab's possibly stale copy.
export const STORE = "lab:likes";
const RECEIPT = /^[0-9a-f]{32}$/; // what the worker hands out and accepts back

/** { project: receipt } */
export type Receipts = Record<string, string>;
/** Just the part of localStorage used here, so tests can pass a stand-in. */
export type ReceiptStorage = Pick<Storage, "getItem" | "setItem">;

/** The stored receipts ({ project: receipt }), or `fallback` when storage can't be used at all. */
export function readReceipts(storage: ReceiptStorage | null, fallback: Receipts = {}): Receipts {
  if (!storage) return { ...fallback };
  let raw: string | null;
  try { raw = storage.getItem(STORE); } catch { return { ...fallback }; }
  try {
    const v: unknown = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    // Anything else (say, a hand-edited value) could never unlike, so it counts as not liked.
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && RECEIPT.test(e[1])));
  } catch { return {}; }
}

/** Remember (or with no receipt, forget) one project's receipt, keeping every other tab's. Returns all receipts. */
export function saveReceipt(storage: ReceiptStorage | null, name: string, receipt: string | null, current: Receipts = {}): Receipts {
  const next = readReceipts(storage, current);
  if (receipt) next[name] = receipt; else delete next[name];
  try { storage?.setItem(STORE, JSON.stringify(next)); } catch {}
  return next;
}

/** Projects that are liked in one set of receipts and not in the other. */
export function flipped(before: Receipts, after: Receipts): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((n) => !before[n] !== !after[n]);
}

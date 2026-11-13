// Like receipts kept in this browser, so it can take a like back. Every open tab shares them,
// so each write re-reads storage and merges, instead of saving a tab's possibly stale copy.
export const STORE = "lab:likes";

/** The stored receipts ({ project: receipt }), or `fallback` when storage can't be used at all. */
export function readReceipts(storage, fallback = {}) {
  let raw;
  try { raw = storage.getItem(STORE); } catch { return { ...fallback }; }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, r]) => typeof r === "string"));
  } catch { return {}; }
}

/** Remember (or with no receipt, forget) one project's receipt, keeping every other tab's. Returns all receipts. */
export function saveReceipt(storage, name, receipt, current = {}) {
  const next = readReceipts(storage, current);
  if (receipt) next[name] = receipt; else delete next[name];
  try { storage.setItem(STORE, JSON.stringify(next)); } catch {}
  return next;
}

/** Projects that are liked in one set of receipts and not in the other. */
export function flipped(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((n) => !before[n] !== !after[n]);
}

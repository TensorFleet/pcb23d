/**
 * Minimal S-expression reader for KiCad files. Atoms are strings (quotes removed, escapes
 * resolved); lists are arrays. Tuned for multi-megabyte `.kicad_pcb` files: no per-character
 * regex, string slices instead of concatenation.
 */
export type SExpr = string | SExpr[];

const enum Ch {
  LParen = 40,
  RParen = 41,
  Quote = 34,
  Backslash = 92,
  Space = 32,
  Tab = 9,
  LF = 10,
  CR = 13,
}

export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let top = root;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === Ch.Space || c === Ch.Tab || c === Ch.LF || c === Ch.CR) {
      i++;
    } else if (c === Ch.LParen) {
      const list: SExpr[] = [];
      top.push(list);
      stack.push(list);
      top = list;
      i++;
    } else if (c === Ch.RParen) {
      if (stack.length === 1) throw new SyntaxError(`unbalanced ')' at offset ${i}`);
      stack.pop();
      top = stack[stack.length - 1]!;
      i++;
    } else if (c === Ch.Quote) {
      let j = i + 1;
      let escaped = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === Ch.Backslash) {
          escaped = true;
          j += 2;
          continue;
        }
        if (d === Ch.Quote) break;
        j++;
      }
      if (j >= n) throw new SyntaxError(`unterminated string at offset ${i}`);
      const raw = text.slice(i + 1, j);
      top.push(escaped ? unescape(raw) : raw);
      i = j + 1;
    } else {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (
          d === Ch.Space ||
          d === Ch.Tab ||
          d === Ch.LF ||
          d === Ch.CR ||
          d === Ch.LParen ||
          d === Ch.RParen
        )
          break;
        j++;
      }
      top.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new SyntaxError("unbalanced '(': missing closing parenthesis");
  return root;
}

function unescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[++i]!;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
    } else out += ch;
  }
  return out;
}

export function isList(x: SExpr | undefined): x is SExpr[] {
  return Array.isArray(x);
}

/** Head token of a list, e.g. `(net 1 "GND")` → `net`. */
export function head(x: SExpr | undefined): string | undefined {
  return isList(x) && typeof x[0] === "string" ? x[0] : undefined;
}

/** Direct children of `list` that are lists headed by `name`. */
export function children(list: SExpr[] | undefined, name: string): SExpr[][] {
  if (!list) return [];
  const out: SExpr[][] = [];
  for (const c of list) if (isList(c) && c[0] === name) out.push(c);
  return out;
}

/** First child list headed by `name`. */
export function child(list: SExpr[] | undefined, name: string): SExpr[] | undefined {
  if (!list) return undefined;
  for (const c of list) if (isList(c) && c[0] === name) return c;
  return undefined;
}

/** String children of a list, skipping the head. */
export function atoms(list: SExpr[] | undefined): string[] {
  const out: string[] = [];
  if (!list) return out;
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (typeof c === "string") out.push(c);
  }
  return out;
}

/** Numeric children of a list, skipping the head and non-numeric atoms. */
export function numbers(list: SExpr[] | undefined): number[] {
  const out: number[] = [];
  for (const a of atoms(list)) {
    const v = Number(a);
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

/** First numeric atom of the child list `name`, or `fallback`. */
export function num(list: SExpr[] | undefined, name: string, fallback = 0): number {
  const v = numbers(child(list, name))[0];
  return v === undefined ? fallback : v;
}

/** First string atom of the child list `name`. */
export function str(list: SExpr[] | undefined, name: string): string | undefined {
  return atoms(child(list, name))[0];
}

/** True when the child `(name yes)` exists or the bare atom `name` appears. */
export function flag(list: SExpr[] | undefined, name: string): boolean {
  if (!list) return false;
  const c = child(list, name);
  if (c) {
    const v = atoms(c)[0];
    return v === undefined || v === "yes" || v === "true";
  }
  return list.some((x) => x === name);
}

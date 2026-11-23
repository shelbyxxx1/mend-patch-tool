// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: the command line, output and exit codes,
// safe paths, format detection, three-tier line matching (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8),
// JSON edits (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  eol: boolean;
}

function fileLines(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, eol: false };
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const trailingWs = (s: string): string => {
  const m = /[ \t]*$/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One hunk/chunk body line: context, old, or new. */
interface Op {
  kind: ' ' | '-' | '+';
  text: string;
}

const oldOf = (ops: Op[]): string[] => ops.filter((o) => o.kind !== '+').map((o) => o.text);
const newOf = (ops: Op[]): string[] => ops.filter((o) => o.kind !== '-').map((o) => o.text);

/** A line as a tier sees it: 0 exact, 1 trailing spaces/tabs removed, 2 both ends removed. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.slice(0, s.length - trailingWs(s).length);
  if (tier === 1) return t;
  return t.slice(leadingWs(t).length);
}

/**
 * The first tier at which O occurs in the file, with every occurrence position
 * (0-based, ascending, overlapping allowed); null when O occurs at no tier.
 * With strict only tier 0 is tried.
 */
function tierMatch(file: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const want = O.map((l) => tierLine(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + O.length <= file.length; i += 1) {
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (tierLine(file[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Replace the k lines at `at` (the matched O) with N: context lines are written
 * as the file's own matched lines, never the patch's; at tier 2 every other
 * line of N is re-indented (P, the leading whitespace of O's first line, is
 * replaced by F, that of the file's first matched line). Returns the new model;
 * the file's line break and final break are unchanged (callers adjust `eol`
 * where the spec says so).
 */
function replaceAt(file: FileModel, at: number, ops: Op[], tier: number): FileModel {
  const O = oldOf(ops);
  const out: string[] = [];
  const p = O.length > 0 ? leadingWs(O[0]!) : '';
  const f = file.lines.length > at ? leadingWs(file.lines[at]!) : '';
  let fi = at;
  for (const op of ops) {
    if (op.kind === ' ') {
      out.push(file.lines[fi]!);
      fi += 1;
    } else if (op.kind === '-') {
      fi += 1;
    } else {
      const l = op.text;
      if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(p)) out.push(f + l.slice(p.length));
      else out.push(l);
    }
  }
  const lines = [...file.lines.slice(0, at), ...out, ...file.lines.slice(at + O.length)];
  return { lines, br: file.br, eol: file.eol };
}

/** Insert N lines at position `at` (0..lines.length), written as they are. */
function insertAt(file: FileModel, at: number, lines: string[]): FileModel {
  const all = [...file.lines.slice(0, at), ...lines, ...file.lines.slice(at)];
  return { lines: all, br: file.br, eol: file.eol };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Strip a leading `a/` or `b/` from a diff path, and read a `---`/`+++` path. */
function diffPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** Parse a unified diff patch (SPEC.md section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, create: false, del: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(line.slice(4));
      const newP = diffPath(lines[i + 1]!.slice(4));
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = { oldPath: oldP === '/dev/null' ? null : oldP, newPath: newP === '/dev/null' ? null : newP, hasPair: true, create: false, del: false, hunks: [] };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        const p = diffPath(line.slice(4));
        cur.newPath = p === '/dev/null' ? null : p;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = readHunk(lines, i, strict);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = readHunk(lines, i, strict);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) edits.push(unifiedEdit(s, strict));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Read one hunk starting at lines[i] (a `@@` line); returns the hunk and the next line index. */
function readHunk(lines: string[], i: number, strict: boolean): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  let j = i + 1;
  const n = lines.length;
  const isBodyEnd = (k: number): boolean => {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) return true;
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) return true;
    return !(l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\'));
  };
  while (j < n && !isBodyEnd(j)) j += 1;
  // Empty lines at the end of a body are not part of it (zero-length patch lines only).
  let end = j;
  while (end > i + 1 && lines[end - 1] === '') end -= 1;
  const ops: Op[] = [];
  for (let k = i + 1; k < end; k += 1) {
    const l = lines[k]!;
    if (l === '') ops.push({ kind: ' ', text: '' });
    else if (l.startsWith(' ')) ops.push({ kind: ' ', text: l.slice(1) });
    else if (l.startsWith('-')) ops.push({ kind: '-', text: l.slice(1) });
    else if (l.startsWith('+')) ops.push({ kind: '+', text: l.slice(1) });
    // A `\` line is a marker for the body line before it, not a line of its own.
  }
  // A `\` line follows the hunk's last context or `+` line: find that line,
  // then check the patch line directly after it.
  let noNl = false;
  let lastCtxOrPlus = -1;
  for (let k = i + 1; k < end; k += 1) {
    const l = lines[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxOrPlus = k;
  }
  if (lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < j && lines[lastCtxOrPlus + 1]!.startsWith('\\')) noNl = true;
  void strict;
  return { hunk: { a, ops, noNl }, next: j };
}

/** One unified section as an edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.oldPath;
  const newPath = s.newPath;
  const isCreate = oldPath === null || s.create;
  const isDelete = !isCreate && (newPath === null || s.del);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const added: string[] = [];
      for (const h of s.hunks) for (const op of h.ops) if (op.kind === '+') added.push(op.text);
      let eol = true;
      if (s.hunks.length > 0) {
        const last = s.hunks[s.hunks.length - 1]!;
        const plus = last.ops.filter((o) => o.kind === '+');
        if (plus.length > 0 && last.noNl) eol = false;
      }
      tree.now.set(newPath, added.length === 0 ? '' : added.join('\n') + (eol ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || tree.get(oldPath) === null) throw new Fail('missing', oldPath ?? '');
    if (isMove && newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let file = fileLines(tree.get(oldPath)!);
    let d = 0;
    for (const h of s.hunks) {
      const O = oldOf(h.ops);
      if (O.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), file.lines.length);
        const inserted = insertAt(file, at, newOf(h.ops));
        const atEnd = at === file.lines.length;
        file = { ...inserted, eol: atEnd ? !h.noNl : file.eol };
        d += newOf(h.ops).length;
        continue;
      }
      const found = tierMatch(file.lines, O, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + O.length === file.lines.length;
      const replaced = replaceAt(file, best, h.ops, found.tier);
      file = { ...replaced, eol: atEnd ? !h.noNl : file.eol };
      d += newOf(h.ops).length - O.length;
    }
    const text = joinFile(file);
    if (isMove && newPath !== null) {
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
      tree.moves.push({ old: oldPath, nw: newPath });
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The `=======` and then the `>>>>>>> REPLACE` after it.
    let eq = -1;
    for (let k = searchAt + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    // The path: nearest line before the SEARCH line, after the previous
    // block's REPLACE line (or the start), not blank and not starting with
    // three backticks once trimmed.
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevReplace; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = fileLines(before);
    const found = tierMatch(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const ops: Op[] = oldLines.map((t) => ({ kind: '-' as const, text: t }));
    for (const t of newLines) ops.push({ kind: '+' as const, text: t });
    const replaced = replaceAt(file, found.positions[0]!, ops, found.tier);
    tree.now.set(path, joinFile(replaced));
  };
}

/** Parse a V4A patch (SPEC.md section 8) into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionAt = i;
    i += 1;
    // Collect this section's lines, up to the next section or `*** End Patch`.
    let end = i;
    while (end < last) {
      const l = lines[end]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      end += 1;
    }
    // Blank lines at the end of a section are not part of it.
    let bodyEnd = end;
    while (bodyEnd > i && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    const body = lines.slice(i, bodyEnd);
    const bodyBase = i;
    i = end;
    if (kind === 'add') {
      const fileLinesOut: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const l = body[k]!;
        if (l === '') fileLinesOut.push('');
        else if (l.startsWith('+')) fileLinesOut.push(l.slice(1));
        else throw new Exit2(`error: parse ${bodyBase + k + 1}`);
      }
      edits.push(((p: string, ls: string[]): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      })(path, fileLinesOut));
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k += 1) throw new Exit2(`error: parse ${bodyBase + k + 1}`);
      edits.push(((p: string): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
    } else {
      edits.push(v4aUpdateEdit(path, body, bodyBase, sectionAt, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, body: string[], bodyBase: number, sectionAt: number, strict: boolean): Edit {
  // Parse the section body into a move target and chunks (parse faults now).
  let moveTo: string | null = null;
  let rest = body;
  let restBase = bodyBase;
  if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
    restBase += 1;
  }
  const chunks: V4aChunk[] = [];
  let k = 0;
  let firstChunk = true;
  while (k < rest.length) {
    const line = rest[k]!;
    let anchor: string | null = null;
    if (line.startsWith('@@')) {
      anchor = line.slice(2).trim();
      if (anchor === '') anchor = null;
      k += 1;
    } else if (!firstChunk) {
      throw new Exit2(`error: parse ${restBase + k + 1}`);
    }
    const ops: Op[] = [];
    let eof = false;
    while (k < rest.length) {
      const l = rest[k]!;
      if (l.startsWith('@@')) break;
      if (l === '*** End of File') {
        eof = true;
        k += 1;
        break;
      }
      if (l === '') ops.push({ kind: ' ', text: '' });
      else if (l.startsWith(' ')) ops.push({ kind: ' ', text: l.slice(1) });
      else if (l.startsWith('-')) ops.push({ kind: '-', text: l.slice(1) });
      else if (l.startsWith('+')) ops.push({ kind: '+', text: l.slice(1) });
      else throw new Exit2(`error: parse ${restBase + k + 1}`);
      k += 1;
    }
    chunks.push({ anchor, ops, eof });
    firstChunk = false;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionAt + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = fileLines(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const top = strict ? 0 : 2;
        for (let tier = 0; tier <= top && foundAt < 0; tier += 1) {
          for (let p = cursor; p < file.lines.length; p += 1) {
            if (tierLine(file.lines[p]!, tier) === tierLine(ch.anchor!, tier)) {
              foundAt = p;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O = oldOf(ch.ops);
      if (O.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const inserted = insertAt(file, at, newOf(ch.ops));
        file = inserted;
        cursor = at + newOf(ch.ops).length;
        continue;
      }
      // First occurrence of O at or after the cursor, at the first tier with
      // one; an end-of-file chunk takes only an occurrence ending at the
      // file's last line.
      let hit: { tier: number; pos: number } | null = null;
      const top = strict ? 0 : 2;
      for (let tier = 0; tier <= top && hit === null; tier += 1) {
        const want = O.map((l) => tierLine(l, tier));
        for (let p = cursor; p + O.length <= file.lines.length; p += 1) {
          if (ch.eof && p + O.length !== file.lines.length) continue;
          let ok = true;
          for (let j = 0; j < O.length; j += 1) {
            if (tierLine(file.lines[p + j]!, tier) !== want[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            hit = { tier, pos: p };
            break;
          }
        }
      }
      if (hit === null) throw new Fail('no-match', path);
      file = replaceAt(file, hit.pos, ch.ops, hit.tier);
      cursor = hit.pos + newOf(ch.ops).length;
    }
    const text = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per path whose state changed, in byte order of the
  // paths (UTF-8); a move that succeeded prints `R <old> -> <new>` in place
  // of its D/A pair, sorting by <new>.
  const movedNew = new Set<string>();
  const movedOld = new Set<string>();
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      movedNew.add(m.nw);
      movedOld.add(m.old);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedNew.has(p) || movedOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

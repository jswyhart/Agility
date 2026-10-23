// Myers' O((N+M)·D) diff, used to compare documents line by line and then word by word.

/**
 * Diff two arrays with an equality function. Returns operations in order:
 * { op: 'equal' | 'delete' | 'insert', a?: index in a, b?: index in b }.
 */
export function diff(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace back from the end to recover the edit path.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ op: 'equal', a: --x, b: --y });
    if (d > 0) {
      if (down) ops.push({ op: 'insert', b: --y });
      else ops.push({ op: 'delete', a: --x });
    }
  }
  return ops.reverse();
}

/** Word-level changes between two strings: [{ text, op: 'equal' | 'delete' | 'insert' }]. */
export function diffWords(oldText, newText) {
  const a = oldText.split(/(\s+)/).filter(Boolean);
  const b = newText.split(/(\s+)/).filter(Boolean);
  const out = [];
  for (const o of diff(a, b)) {
    const text = o.op === 'insert' ? b[o.b] : a[o.a];
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += text;
    else out.push({ text, op: o.op });
  }
  return out;
}

/**
 * Compare two documents given as arrays of lines ({ text, page, ... }).
 * Returns hunks: { kind: 'changed' | 'added' | 'removed', old: lines[], new: lines[], words }.
 */
export function compareLines(oldLines, newLines) {
  const norm = (l) => l.text.replace(/\s+/g, ' ').trim();
  const ops = diff(oldLines, newLines, (p, q) => norm(p) === norm(q));
  const hunks = [];
  let cur = null;
  let nextNew = 0; // index in newLines of the line after everything seen so far
  for (const o of ops) {
    if (o.op === 'equal') {
      cur = null;
      nextNew = o.b + 1;
      continue;
    }
    if (!cur) {
      cur = { old: [], new: [], at: nextNew };
      hunks.push(cur);
    }
    if (o.op === 'delete') cur.old.push(oldLines[o.a]);
    else {
      cur.new.push(newLines[o.b]);
      nextNew = o.b + 1;
    }
  }
  return hunks.map((hk) => ({
    kind: hk.old.length && hk.new.length ? 'changed' : hk.new.length ? 'added' : 'removed',
    old: hk.old,
    new: hk.new,
    // Where to point in the new document; a pure removal marks the line after it.
    anchor: hk.new[0] || newLines[hk.at] || newLines[newLines.length - 1] || null,
    words: hk.old.length && hk.new.length ? diffWords(hk.old.map(norm).join(' '), hk.new.map(norm).join(' ')) : null,
  }));
}

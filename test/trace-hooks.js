// Loader hook: turns each top-level "// Title" comment group (and each blank-line-separated "  // sub-step" inside a block) in the test file
// into a `__t("Title")` call on the same line (line numbers stay intact).
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!/\/test\/[^/]+\.test\.js$/.test(url)) return r;
  const lines = String(r.source).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].startsWith('// ') && !(i > 0 && lines[i - 1].startsWith('// '));
    const sub = lines[i].startsWith('  // ') && i > 0 && lines[i - 1].trim() === '';
    if (top || sub) lines[i] = `__t(${JSON.stringify(lines[i].trim().slice(3))}, ${i + 1}, ${sub}); ${lines[i]}`;
  }
  return { ...r, source: lines.join('\n') };
}

// Build a prototype: src/<name>.html + msg/<name>/<tag>.js -> ../<name>-prototype.html
// Usage: node tools/build.mjs <name> [--check-only]
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const name = process.argv[2];
const TAGS = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
const PLURAL = new Set(["zero", "one", "two", "few", "many", "other"]);
const load = (f) => new Function("return (" + fs.readFileSync(f, "utf8") + ")")();
const msgs = {};
for (const tag of TAGS) {
  const f = path.join(root, "msg", name, tag + ".js.fragment");
  if (!fs.existsSync(f)) { console.error("missing file", f); process.exitCode = 1; continue; }
  msgs[tag] = load(f);
}
const errors = [];
const isPlural = (v) => v && typeof v === "object" && !Array.isArray(v) && "other" in v && Object.keys(v).every((k) => PLURAL.has(k));
const holes = (s) => new Set((String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []));
function placeholders(v) { if (typeof v === "string") return holes(v); if (isPlural(v)) { const s = new Set(); Object.values(v).forEach((x) => holes(x).forEach((h) => s.add(h))); s.delete("{n}"); return s; } return new Set(); }
function compare(en, other, tag, p) {
  if (isPlural(en)) {
    if (typeof other === "string") return; // languages without number agreement may use one form
    if (!isPlural(other)) return errors.push(`${tag}:${p} should be plural forms`);
    if (tag === "ru" && !(other.one && other.few && other.many)) errors.push(`${tag}:${p} needs one/few/many`);
  } else if (Array.isArray(en)) {
    if (!Array.isArray(other) || other.length !== en.length) return errors.push(`${tag}:${p} array length`);
    en.forEach((x, i) => compare(x, other[i], tag, p + "[" + i + "]"));
    return;
  } else if (en && typeof en === "object") {
    if (!other || typeof other !== "object") return errors.push(`${tag}:${p} should be object`);
    for (const k of Object.keys(en)) { if (!(k in other)) errors.push(`${tag}: missing ${p}${p ? "." : ""}${k}`); else compare(en[k], other[k], tag, (p ? p + "." : "") + k); }
    for (const k of Object.keys(other)) if (!(k in en)) errors.push(`${tag}: extra ${p}${p ? "." : ""}${k}`);
    return;
  } else if (typeof other !== "string" && !isPlural(other)) return errors.push(`${tag}:${p} should be string`);
  if (typeof other === "string" && !other.trim() && String(en).trim()) errors.push(`${tag}:${p} empty`);
  const a = [...placeholders(en)].sort().join(), b = [...placeholders(other)].sort().join();
  if (a !== b) errors.push(`${tag}:${p} placeholders ${a} vs ${b}`);
}
for (const tag of TAGS.slice(1)) if (msgs[tag]) compare(msgs.en, msgs[tag], tag, "");
if (errors.length) { console.error(errors.join("\n")); console.error(errors.length + " problems"); process.exit(1); }
const count = (o) => Object.values(o).reduce((n, v) => n + (typeof v === "string" ? 1 : Array.isArray(v) ? v.length : isPlural(v) ? 1 : count(v)), 0);
console.log(`${name}: ${count(msgs.en)} messages x ${TAGS.length} languages OK`);
if (process.argv.includes("--check-only")) process.exit(0);
let html = fs.readFileSync(path.join(root, "src", name + ".html"), "utf8");
const kitJs = fs.readFileSync(path.join(root, "src", "kit.js.fragment"), "utf8");
const kitCss = fs.readFileSync(path.join(root, "src", "kit.css"), "utf8");
const table = "/* Interface strings: one object per language (English is the reference; the others are unreviewed drafts). */\nconst MESSAGES = {\n" +
  TAGS.map((t) => JSON.stringify(t) + ": " + JSON.stringify(msgs[t])).join(",\n") + "\n};";
for (const [mark, val] of [["/*@@KIT_CSS@@*/", kitCss], ["/*@@KIT_JS@@*/", kitJs], ["/*@@MESSAGES@@*/", table]]) {
  if (!html.includes(mark)) { console.error("template lacks " + mark); process.exit(1); }
  html = html.split(mark).join(val);
}
fs.writeFileSync(path.join(path.dirname(root), name + "-prototype.html"), html);
console.log("wrote " + name + "-prototype.html (" + html.length + " bytes)");

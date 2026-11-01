// Headless verification: node tools/verify.mjs <name>
// Switches through all seven languages with the picker, walks every scenario state, and reports
// console errors, network requests, key/placeholder leaks, English leaks, untranslated text and horizontal overflow.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(path.resolve(process.env.PROTOTYPE_DEPS || ".", "package.json"));
const { chromium } = require("playwright");
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const name = process.argv[2];
const file = "file://" + path.join(root, "../..", name + "-prototype.html");
const { states } = await import(path.join(root, "tools", "scenarios", name + ".mjs"));
const TAGS = ["en", "es", "ru", "uz-Latn", "ka", "hy", "az-Latn"];
const report = { console: [], network: [], leaks: [], same: [], overflow: [], keyboard: [] };

// Runs in the page: visible-or-not text of the interface in the document language, minus explicitly foreign content.
function collect() {
  const docLang = document.documentElement.lang;
  const foreign = (el) => { const l = el.closest("[lang]"); return l && l !== document.documentElement && l.getAttribute("lang") !== docLang; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement; if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName) || foreign(p)) continue;
    if (p.closest(".lp-pop")) continue; // language names are deliberately in their own languages
    const s = n.nodeValue.replace(/\s+/g, " ").trim(); if (s) out.push(s);
  }
  document.querySelectorAll("[aria-label],[title],[placeholder]").forEach((el) => {
    if (foreign(el) || el.closest(".lp-pop")) return;
    for (const a of ["aria-label", "title", "placeholder"]) { const v = el.getAttribute(a); if (v && v.trim()) out.push("@" + a + ": " + v.trim()); }
  });
  out.push("@title: " + document.title);
  return out;
}
const NAMES = /\b(?:Example|Synthetic|Sample|Demo|Placeholder|Trustwork|Coastline|Pacific|Harbor|Mesa Vista|Maria|Alex|Dana|Mshenebloba|Shinararutyun|Qurilish|Lisboa|Bayern|Bajío)(?:[ -](?:[A-Z0-9][\w.'’&-]*|of|and|the|in|for|de|do)|\.)*/g;
const STOP = /(?<![\p{L}\p{N}ʻʼ’'])(the|and|of|is|are|your|with|for|this|that|from|will|have|been|which|when|must|cannot|without|into|after|before|every|each|only|not|you|our|by|to|or|be|was|it|its|per|any|all|no one|here|there|yes)(?![\p{L}\p{N}ʻʼ’'])/iu;
function check(tag, state, texts, enTexts) {
  const enSet = new Set(enTexts || []);
  for (const raw of texts) {
    const s = raw.replace(/^@[a-z-]+: /, "");
    if (/undefined|\[object|NaN|\{[a-zA-Z_]+\}/.test(s)) report.leaks.push({ tag, state, kind: "placeholder", s: raw });
    if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s) || /\b[a-z]+_[a-z_]+\b/.test(s.replace(/[\w.-]+@[\w.-]+|trustwork:\/\/\S+|\w+\.\w+_\w+/g, ""))) report.leaks.push({ tag, state, kind: "key-like", s: raw });
    if (tag === "en") continue;
    const stripped = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+|\b[\w-]+(\.[\w-]+)*\.(invalid|gov|pdf|xlsx|txt|com)\b|trustwork:\/\/\S+|https?:\/\/\S+/g, " ").replace(NAMES, " ");
    if (STOP.test(stripped) && /[a-z]{3,}/.test(stripped)) report.leaks.push({ tag, state, kind: "english", s: raw });
    if (tag !== "ru" && /[Ѐ-ӿ]{3,}/.test(s)) report.leaks.push({ tag, state, kind: "cyrillic", s: raw });
    if (enSet.has(raw) && /[A-Za-z]{3,}/.test(stripped) && !/^[A-Z0-9][\w./-]*$/.test(stripped.trim())) report.same.push({ tag, state, s: raw });
  }
}
const browser = await chromium.launch();
const enByState = {};
for (const width of [1280, 375]) {
  for (const tag of TAGS) {
    const ctx = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") report.console.push({ tag, width, s: m.text() }); });
    page.on("pageerror", (e) => report.console.push({ tag, width, s: "pageerror: " + e.message }));
    page.on("request", (r) => { if (!/^(file|data|about|blob):/.test(r.url())) report.network.push(r.url()); });
    await page.route("**/*", route => /^(file|data|about|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    page.setDefaultTimeout(4000);
    await page.goto(file);
    if (tag !== "en") {
      await page.click(".lp-btn");
      await page.click(`.lp-opt[data-lp="${tag}"]`);
    }
    const lang = await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]);
    if (lang[0] !== tag || lang[1] !== "ltr") report.keyboard.push({ tag, problem: "html lang/dir " + lang.join("/") });
    for (const st of states) {
      try { await st.run(page, tag); } catch (e) { report.console.push({ tag, width, s: "scenario " + st.name + ": " + e.message.split("\n")[0] }); continue; }
      await page.waitForTimeout(st.wait || 30);
      if (width === 1280) {
        const texts = await page.evaluate(collect);
        if (tag === "en") enByState[st.name] = texts; else check(tag, st.name, texts, enByState[st.name]);
        if (tag === "en") check(tag, st.name, texts);
      } else {
        const ov = await page.evaluate(() => {
          const w = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth <= w + 1) return null;
          const wide = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > w + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed" && !el.closest("[hidden]"); }).slice(0, 3).map((el) => el.tagName + "." + el.className + " " + (el.textContent || "").slice(0, 40));
          return { sw: document.documentElement.scrollWidth, w, wide };
        });
        if (ov) report.overflow.push({ tag, width, state: st.name, ...ov });
      }
    }
    await ctx.close();
  }
}
// Keyboard and persistence: open with Enter, move with arrows, choose with Enter, Escape closes, choice survives reload.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.route("**/*", route => /^(file|data|about|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    page.setDefaultTimeout(4000);
    await page.goto(file);
  await page.focus(".lp-btn"); await page.keyboard.press("Enter");
  const opened = await page.evaluate(() => document.activeElement.classList.contains("lp-opt") && document.activeElement.dataset.lp);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  const after = await page.evaluate(() => [document.documentElement.lang, document.activeElement.classList.contains("lp-btn"), document.querySelector(".lp-pop").hidden]);
  await page.keyboard.press("Enter"); await page.keyboard.press("Escape");
  const esc = await page.evaluate(() => [document.querySelector(".lp-pop").hidden, document.activeElement.classList.contains("lp-btn")]);
  await page.reload();
  const kept = await page.evaluate(() => document.documentElement.lang);
  report.keyboard.push({ opened, after, esc, kept, ok: opened === "en" && after[0] === "es" && after[1] && after[2] && esc[0] && esc[1] && kept === "es" });
  await ctx.close();
}
await browser.close();
const uniq = (arr) => [...new Map(arr.map((x) => [JSON.stringify(x), x])).values()];
report.console = uniq(report.console); report.network = [...new Set(report.network)];
report.leaks = uniq(report.leaks); report.same = uniq(report.same.map(({ tag, s }) => ({ tag, s }))); report.overflow = uniq(report.overflow);
fs.writeFileSync(path.join(root, "../../evidence", "verify-" + name + ".json"), JSON.stringify(report, null, 1));
console.log(`${name}: states=${states.length} console=${report.console.length} network=${report.network.length} leaks=${report.leaks.length} same-as-en=${report.same.length} overflow=${report.overflow.length} keyboard=${JSON.stringify(report.keyboard.at(-1))}`);

if(report.console.length || report.network.length || report.overflow.length || report.keyboard.some(x=>x.ok===false||x.problem))process.exitCode=1;

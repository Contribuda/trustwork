/* ---------- Language kit: the seven engine languages (shared by the Trustwork prototypes) ---------- */
/* Every user-facing string lives in MESSAGES[tag]: one object per language. English is the reference. */
const L10N = (function () {
  "use strict";
  // Order and own names follow the product's language list (en, es, ru, uz-Latn, ka, hy, az-Latn).
  // `review` mirrors docs/engine/localization.md: everything except English is unreviewed text in these prototypes.
  const LOCALES = [
    { tag: "en", name: "English", fmt: "en-US", dir: "ltr", review: "reference" },
    { tag: "es", name: "Español", fmt: "es-US", dir: "ltr", review: "machine" },
    { tag: "ru", name: "Русский", fmt: "ru-RU", dir: "ltr", review: "unreviewed" },
    { tag: "uz-Latn", name: "Oʻzbekcha", fmt: "uz-Latn", dir: "ltr", review: "machine" },
    { tag: "ka", name: "ქართული", fmt: "ka", dir: "ltr", review: "machine" },
    { tag: "hy", name: "Հայերեն", fmt: "hy", dir: "ltr", review: "machine" },
    { tag: "az-Latn", name: "Azərbaycanca", fmt: "az-Latn", dir: "ltr", review: "machine" }
  ];
  /*@@KIT@@*/
  const STORE = "trustwork.prototype.lang";
  const listeners = [];
  let lang = "en";
  try { const saved = localStorage.getItem(STORE); if (LOCALES.some(function (l) { return l.tag === saved; })) lang = saved; } catch (e) { /* storage unavailable: keep English */ }

  function info(tag) { return LOCALES.find(function (l) { return l.tag === (tag || lang); }); }
  function fmt() { return info().fmt; }
  function lookup(tag, key) {
    const table = (typeof MESSAGES !== "undefined" && MESSAGES[tag]) || {};
    return key.split(".").reduce(function (o, k) { return o != null ? o[k] : undefined; }, table);
  }
  function interp(s, vars) {
    if (!vars) return s;
    return Object.keys(vars).reduce(function (acc, k) { return acc.split("{" + k + "}").join(vars[k]); }, s);
  }
  /** A message in the active language: a string (interpolated), an array or an object. Missing keys are reported. */
  function t(key, vars) {
    let v = lookup(lang, key);
    if (v === undefined) {
      console.error("Missing message", lang, key);
      v = lookup("en", key);
      if (v === undefined) return key;
    }
    return typeof v === "string" ? interp(v, vars) : v;
  }
  /** A counted message: {one, few, many, other} chosen with Intl.PluralRules; {n} is the formatted count. */
  function tp(key, n, vars) {
    const forms = t(key);
    const form = typeof forms === "string" ? forms : (forms[new Intl.PluralRules(fmt()).select(n)] || forms.other);
    return interp(form, Object.assign({ n: num(n) }, vars || {}));
  }
  /* Browsers trim their ICU data: Chrome has no date, number or region data for Uzbek, Georgian, Armenian or
     Azerbaijani. These four always use the CLDR-based patterns below, so every browser shows the same text. */
  /*@@CLDR@@*/
  function cldr() { return CLDR[lang]; }
  function swap(s, c) { return s.replace(/[,.]/g, function (ch) { return ch === "," ? "\u0001" : "\u0002"; }).replace(/\u0001/g, c.group).replace(/\u0002/g, c.decimal); }
  function num(n, opts) { const c = cldr(); const s = new Intl.NumberFormat(c ? "en-US" : fmt(), opts).format(n); return c ? swap(s, c) : s; }
  function money(n, opts) {
    const o = Object.assign({ style: "currency", currency: "USD" }, opts || {}), c = cldr();
    if (!c) return new Intl.NumberFormat(fmt(), o).format(n);
    const plain = Object.assign({}, o); delete plain.style; delete plain.currency;
    if (plain.minimumFractionDigits == null && plain.maximumFractionDigits == null) { plain.minimumFractionDigits = 2; plain.maximumFractionDigits = 2; }
    if (plain.maximumFractionDigits != null && plain.minimumFractionDigits == null) plain.minimumFractionDigits = Math.min(plain.maximumFractionDigits, 2);
    return interp(c.currency, { n: num(n, plain) });
  }
  function date(d, opts) {
    const when = d instanceof Date ? d : new Date(d), o = opts || { dateStyle: "medium" }, c = cldr();
    if (!c) return new Intl.DateTimeFormat(fmt(), o).format(when);
    const parts = {};
    new Intl.DateTimeFormat("en-US", { timeZone: o.timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(when).forEach(function (p) { parts[p.type] = p.value; });
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    const time = String(parts.hour).padStart(2, "0") + ":" + parts.minute;
    const v = { d: String(Number(parts.day)), M: c.months[Number(parts.month) - 1], y: parts.year };
    const withTime = !!(o.timeStyle || o.hour);
    if (o.timeStyle && !o.dateStyle) return time;
    if (o.weekday && !o.month) return c.weekdays[wd] + (withTime ? " " + time : "");
    const dayText = interp(o.dateStyle || o.year ? c.date : c.monthDay, v);
    return withTime ? dayText + ", " + time : dayText;
  }
  function percent(n, digits) { return num(n, { maximumFractionDigits: digits == null ? 0 : digits, minimumFractionDigits: digits == null ? 0 : digits }) + "%"; }
  function region(code) { const c = cldr(); if (c && c.region[code]) return c.region[code]; try { return new Intl.DisplayNames([fmt()], { type: "region" }).of(code) || code; } catch (e) { return code; } }
  function list(items) { if (cldr()) return items.join(", "); try { return new Intl.ListFormat(fmt(), { style: "short", type: "conjunction" }).format(items); } catch (e) { return items.join(", "); } }

  function apply() {
    const l = info();
    document.documentElement.lang = l.tag;
    document.documentElement.dir = l.dir;
  }
  function set(tag) {
    if (!info(tag) || tag === lang) return;
    lang = tag;
    try { localStorage.setItem(STORE, tag); } catch (e) { /* not remembered */ }
    apply();
    pickers.forEach(function (p) { p.refresh(); });
    listeners.forEach(function (fn) { fn(tag); });
  }
  function onChange(fn) { listeners.push(fn); }

  const GLOBE = '<svg class="lp-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>';
  const CARET = '<svg class="lp-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const pickers = [];
  let seq = 0;
  /** Disclosure button plus a group of pressed-state buttons, one per engine language, each in its own name and script. */
  function mount(host) {
    const id = "lp-pop-" + (++seq);
    host.classList.add("lp");
    host.innerHTML = '<button type="button" class="lp-btn" aria-expanded="false" aria-controls="' + id + '">' + GLOBE + '<span class="lp-cur"></span>' + CARET + '</button><div class="lp-pop" id="' + id + '" role="group" hidden></div>';
    const btn = host.querySelector(".lp-btn"), pop = host.querySelector(".lp-pop"), cur = host.querySelector(".lp-cur");
    function options() { return Array.prototype.slice.call(pop.querySelectorAll(".lp-opt")); }
    function close(focusBtn) { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focusBtn) btn.focus(); }
    function open() {
      pop.hidden = false; btn.setAttribute("aria-expanded", "true");
      pop.style.cssText = "";
      if (window.innerWidth < 640) {
        // Phone: a full-width sheet under the button, never wider than the screen.
        const b = btn.getBoundingClientRect();
        pop.style.cssText = "position:fixed;left:16px;right:16px;width:auto;max-width:none;top:" + Math.round(b.bottom + 6) + "px;max-height:calc(100vh - " + Math.round(b.bottom + 22) + "px);overflow:auto";
      } else {
        const r = pop.getBoundingClientRect();
        if (r.left < 8) { pop.style.right = "auto"; pop.style.left = "0"; }
      }
      const active = pop.querySelector('[aria-pressed="true"]') || options()[0];
      active.focus();
    }
    function refresh() {
      const l = info();
      cur.textContent = l.name; cur.setAttribute("lang", l.tag);
      btn.setAttribute("aria-label", l.name + " – " + KIT[l.tag].label);
      pop.setAttribute("aria-label", KIT[l.tag].label);
      pop.innerHTML = LOCALES.map(function (o) {
        const k = KIT[o.tag];
        const note = o.review === "machine" ? k.machine : o.review === "unreviewed" ? k.unreviewed : "";
        const title = o.review === "machine" ? k.machineTitle : o.review === "unreviewed" ? k.unreviewedTitle : "";
        return '<button type="button" class="lp-opt" data-lp="' + o.tag + '" lang="' + o.tag + '" aria-pressed="' + (o.tag === lang) + '"' + (title ? ' title="' + title + '"' : "") + '>' +
          '<span class="lp-check" aria-hidden="true">' + (o.tag === lang ? "✓" : "") + '</span><span class="lp-name">' + o.name + '</span>' +
          (note ? '<small class="lp-note">' + note + '</small>' : "") + '</button>';
      }).join("");
    }
    btn.addEventListener("click", function () { if (pop.hidden) open(); else close(false); });
    pop.addEventListener("click", function (e) { const o = e.target.closest(".lp-opt"); if (!o) return; close(true); set(o.getAttribute("data-lp")); });
    pop.addEventListener("keydown", function (e) {
      const opts = options(), i = opts.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); opts[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1].focus(); }
    });
    host.addEventListener("focusout", function (e) { if (!pop.hidden && e.relatedTarget && !host.contains(e.relatedTarget)) close(false); });
    document.addEventListener("click", function (e) { if (!pop.hidden && !host.contains(e.target)) close(false); });
    refresh();
    pickers.push({ refresh: refresh });
  }
  function tabs(){
    document.querySelectorAll('[role="tablist"]').forEach(group=>group.querySelectorAll('[role="tab"]').forEach(tab=>tab.tabIndex=tab.getAttribute('aria-selected')==='true'?0:-1));
  }
  document.addEventListener('keydown',event=>{
    const tab=event.target.closest?.('[role="tab"]');
    if(!tab||tab.dataset.tabs||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const group=tab.closest('[role="tablist"]'),items=[...group.querySelectorAll('[role="tab"]')].filter(t=>!t.disabled);
    const i=items.indexOf(tab),next=items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowRight'?1:-1)+items.length)%items.length];
    if(!next)return;event.preventDefault();
    const selector=next.id?'#'+CSS.escape(next.id):Object.entries(next.dataset).map(([k,v])=>'[data-'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+'="'+CSS.escape(v)+'"]').join('');
    next.click();tabs();if(selector)document.querySelector(selector)?.focus();
  });
  apply();
  return {
    tabs: tabs, LOCALES: LOCALES, get lang() { return lang; }, fmt: fmt, t: t, tp: tp, num: num, money: money, date: date, percent: percent,
    region: region, list: list, set: set, onChange: onChange, mount: mount
  };
})();
/* Relative time fallback for browsers with reduced locale data. Numeric parts still use Intl. */
/*@@RELATIVE_UNITS@@*/
function prototypeRelative(n,unit){const locale=L10N.lang,table=RELATIVE_UNITS[locale];if(!table)return new Intl.RelativeTimeFormat(L10N.fmt(),{numeric:'auto',style:'short'}).format(n,unit);return table[n<0?'past':'future'].replace('{n}',L10N.num(Math.abs(n))).replace('{unit}',table[unit]);}
function prototypeUnit(n,unit){const table=RELATIVE_UNITS[L10N.lang];return table?L10N.num(n)+' '+table[unit]:new Intl.NumberFormat(L10N.fmt(),{style:'unit',unit,unitDisplay:'narrow',maximumFractionDigits:1}).format(n);}

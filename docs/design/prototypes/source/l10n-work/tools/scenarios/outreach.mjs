const tab = (v) => async (p) => { await p.click(`nav.tabs button[data-v="${v}"]`); };
const act = (a) => async (p) => { await p.click(`[data-a="${a}"]`); };
export const states = [
  { name: "page", run: tab("page") },
  { name: "toast-claim", run: act("claim") },
  { name: "review0", run: tab("review") },
  { name: "review-batch", run: act("batch") },
  { name: "review2", run: async (p) => { await p.click('[data-sel="2"]'); } },
  { name: "review1-link", run: async (p) => { await p.click('[data-sel="1"]'); await p.click('[data-a="link"]'); } },
  { name: "campaign-strict", run: tab("campaign") },
  { name: "campaign-dry-strict", run: act("dry") },
  { name: "campaign-notice", run: async (p) => { await p.selectOption("#mode", "notice"); } },
  { name: "campaign-r1", run: async (p) => { await p.selectOption("#recip", "1"); } },
  { name: "campaign-r2", run: async (p) => { await p.selectOption("#recip", "2"); } },
  { name: "campaign-r3", run: async (p) => { await p.selectOption("#recip", "3"); } },
  { name: "campaign-dry", run: act("dry") },
  { name: "campaign-es", run: async (p) => { await p.selectOption("#pvl", "es"); } },
  { name: "claims0", run: tab("claims") },
  { name: "claims1", run: async (p) => { await p.click('[data-claim="1"]'); } },
  { name: "claims2", run: async (p) => { await p.click('[data-claim="2"]'); } },
  { name: "object0", run: tab("object") },
  { name: "object1", run: act("onext") },
  { name: "object-sent", run: act("osend") },
  { name: "object2", run: async (p) => { await p.fill("#ocode", "123456"); await p.click('[data-a="overify"]'); } },
  { name: "object-look", run: act("look") },
  { name: "picker-open", run: async (p) => { await p.click(".lp-btn"); } },
  { name: "picker-close", run: async (p) => { await p.keyboard.press("Escape"); } }
];

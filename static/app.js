/* ============================================================
   书帖结构复原台 —— 前端逻辑（原生 JS + SVG，无外部依赖）
   ============================================================ */
"use strict";

/* ---------------- 小工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
const sid = (id) => String(id).slice(-4);
const clone = (o) => JSON.parse(JSON.stringify(o));

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ---------------- API ---------------- */
const api = {
  async list() {
    const r = await fetch("/api/hypotheses");
    return (await r.json()).hypotheses || [];
  },
  async get(id) {
    const r = await fetch("/api/hypotheses/" + id);
    if (!r.ok) throw new Error("加载失败");
    return r.json();
  },
  async create(id, name, data) {
    const r = await fetch("/api/hypotheses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, data }),
    });
    if (!r.ok) throw new Error((await r.json()).error || "创建失败");
    return r.json();
  },
  async update(id, name, data) {
    const r = await fetch("/api/hypotheses/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data }),
    });
    if (!r.ok) throw new Error("保存失败");
    return r.json();
  },
  async remove(id) {
    await fetch("/api/hypotheses/" + id, { method: "DELETE" });
  },
};

/* ---------------- 全局状态 ---------------- */
const state = {
  doc: null,                 // 当前工作文档
  meta: null,                // {id,name,updated_at}
  dirty: false,
  selection: null,           // {kind:'leaf'|'pair'|'quire', id}
  view: "all",
  lockMode: false,
  splitMode: false,
  mergeMode: false,
  issueFilter: new Set(),
  hypos: [],
  issues: [],
};

/* 撤销/重做：快照栈 */
const undoStack = [];
const redoStack = [];
const UNDO_MAX = 100;

function snapshotLabel(label) { return label; }
function pushUndo(label) {
  undoStack.push({ doc: clone(state.doc), label });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push({ doc: clone(state.doc), label: s.label });
  state.doc = s.doc;
  afterStructural("已撤销：" + s.label);
}
function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push({ doc: clone(state.doc), label: s.label });
  state.doc = s.doc;
  afterStructural("已重做：" + s.label);
}

/* ---------------- 文档结构 ---------------- */
function blankDocument(title) {
  return { version: 1, title: title || "未命名卷子", leaves: [], pairs: [], quires: [], notes: "" };
}
function leafById(id) { return state.doc.leaves.find((l) => l.id === id); }
function quireById(id) { return state.doc.quires.find((q) => q.id === id); }
function pairById(id) { return state.doc.pairs.find((p) => p.id === id); }
function pairOf(leafId) { return state.doc.pairs.find((p) => p.a === leafId || p.b === leafId); }
function quireOf(leafId) {
  return state.doc.quires.find((q) => q.leaves.includes(leafId));
}
function leafIndex(leafId) {
  const q = quireOf(leafId);
  return q ? q.leaves.indexOf(leafId) : -1;
}
function leafLabel(l) {
  if (!l) return "？";
  if (l.folio) return "第" + l.folio + "叶";
  return (l.frag ? "残片·" : "无码叶·") + sid(l.id);
}
function isPairBifolio(p) { return true; }

/* ---------------- 叶码解析（阿拉伯数字 / 中文数字） ---------------- */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let n = 0, d = 0, ok = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) { d = CN_DIGIT[ch]; ok = true; }
    else if (ch === "十") { n += (d || 1) * 10; d = 0; ok = true; }
    else if (ch === "百") { n += (d || 1) * 100; d = 0; ok = true; }
    else return null;
  }
  return ok ? n + d : null;
}
function parseFolio(text) {
  if (!text) return null;
  const m = String(text).match(/[0-9]+|[〇零一二两三四五六七八九十百]+/);
  if (!m) return null;
  return cnToNum(m[0]);
}

/* ============================================================
   变更操作（每个变更先压入撤销栈）
   ============================================================ */
function commit(label, fn) {
  pushUndo(label);
  fn();
  afterStructural(label);
}
function markDirty() {
  state.dirty = true;
  $("#dirtyLine").classList.remove("hidden");
  $("#btnUndo").disabled = undoStack.length === 0;
  $("#btnRedo").disabled = redoStack.length === 0;
}
function afterStructural(msg) {
  state.issues = validate(state.doc);
  markDirty();
  renderAll();
  if (msg) toast(msg, 1200);
}

/* 锁定判定：锁定模式下，已确认对象 / 锁定帖不可动 */
function leafLocked(lid) {
  if (!state.lockMode) return false;
  const l = leafById(lid);
  const q = quireOf(lid);
  const p = pairOf(lid);
  return (l && l.status === "confirmed") || (q && q.locked) ||
    (p && p.status === "confirmed");
}
function quireLocked(q) { return state.lockMode && q && q.locked; }
function ensureNotLocked(...ids) {
  for (const id of ids) {
    if (id && leafLocked(id)) { toast("已确认叶件已锁定，请先解除「只重排存疑项」或改为存疑"); return false; }
  }
  return true;
}

function makeLeaf(kind) {
  return {
    id: uid("l"),
    folio: "",
    faces: { recto: "", verso: "" },
    status: "doubt",
    frag: kind === "frag",
    note: "",
    evidence: { fold: "none", seam: false, holes: 0 },
  };
}

function addLeaf(kind, qId, index) {
  if (qId) { const q = quireById(qId); if (quireLocked(q)) { toast("该书帖已锁定"); return; } }
  commit("添加" + ({ bifolio: "双叶", single: "单叶", frag: "残片" }[kind] || "叶件"), () => {
    if (kind === "bifolio") {
      const a = makeLeaf("single"), b = makeLeaf("single");
      state.doc.leaves.push(a, b);
      state.doc.pairs.push({ id: uid("p"), a: a.id, b: b.id, status: "doubt", evidence: { join: false, threadMatch: false } });
      if (qId) {
        const q = quireById(qId);
        const at = index == null ? q.leaves.length : index;
        q.leaves.splice(at, 0, a.id, b.id);
      }
      state.selection = { kind: "pair", id: pairOf(a.id).id };
    } else {
      const l = makeLeaf(kind);
      state.doc.leaves.push(l);
      if (qId) {
        const q = quireById(qId);
        const at = index == null ? q.leaves.length : index;
        q.leaves.splice(at, 0, l.id);
      }
      state.selection = { kind: "leaf", id: l.id };
    }
  });
}

function addQuire() {
  commit("添加书帖", () => {
    const q = { id: uid("q"), name: "帖" + (state.doc.quires.length + 1),
      locked: false, leaves: [] };
    state.doc.quires.push(q);
    state.selection = { kind: "quire", id: q.id };
  });
}

function moveLeaf(lid, qId, index) {
  if (!ensureNotLocked(lid)) return;
  const src = quireOf(lid);
  const dst = quireById(qId);
  if (!dst || (src && quireLocked(src)) || quireLocked(dst)) { toast("涉及书帖已锁定"); return; }
  if (src && src.id === qId && src.leaves[index] === lid) return;
  // 计算实际插入位（删除原叶后右移目标位减一），若位置不变则视为空操作
  const from = src ? src.leaves.indexOf(lid) : -1;
  const adjAt = src === dst && from >= 0 && from < index ? index - 1 : index;
  if (src === dst && adjAt === from) return;
  commit("移动 " + leafLabel(leafById(lid)), () => {
    let at = index;
    if (src) {
      src.leaves.splice(from, 1);
      if (src === dst && from < at) at -= 1;
    }
    at = Math.max(0, Math.min(at, dst.leaves.length));
    dst.leaves.splice(at, 0, lid);
  });
}

function sendToTray(lid) {
  if (!ensureNotLocked(lid)) return;
  const q = quireOf(lid);
  if (!q) return;
  commit("移回待编区：" + leafLabel(leafById(lid)), () => {
    q.leaves.splice(q.leaves.indexOf(lid), 1);
  });
}

function deleteLeaf(lid) {
  if (!ensureNotLocked(lid)) return;
  if (!confirm("删除该叶件及其配叶记录？（残片同样适用）")) return;
  commit("删除 " + leafLabel(leafById(lid)), () => {
    const q = quireOf(lid);
    if (q) q.leaves.splice(q.leaves.indexOf(lid), 1);
    state.doc.leaves = state.doc.leaves.filter((l) => l.id !== lid);
    state.doc.pairs = state.doc.pairs.filter((p) => p.a !== lid && p.b !== lid);
    state.selection = null;
  });
}

function updateLeaf(lid, patch, evPatch) {
  const l = leafById(lid);
  if (!l) return;
  if (leafLocked(lid)) { toast("叶件已锁定"); return; }
  pushUndo("编辑叶件信息");
  Object.assign(l, patch);
  if (evPatch) Object.assign(l.evidence, evPatch);
  afterStructural("");
}

function makePair(a, b) {
  if (a === b) return;
  if (!ensureNotLocked(a, b)) return;
  if (pairOf(a) || pairOf(b)) { toast("其中一叶已在双叶中，请先解除原配对"); return; }
  commit("配成双叶：" + leafLabel(leafById(a)) + " ⌒ " + leafLabel(leafById(b)), () => {
    state.doc.pairs.push({ id: uid("p"), a, b, status: "doubt", evidence: { join: false, threadMatch: false } });
    state.selection = { kind: "pair", id: state.doc.pairs[state.doc.pairs.length - 1].id };
  });
}
function breakPair(pid) {
  const p = pairById(pid);
  if (!p) return;
  if (!ensureNotLocked(p.a, p.b)) return;
  commit("解除配叶", () => {
    state.doc.pairs = state.doc.pairs.filter((x) => x.id !== pid);
    state.selection = null;
  });
}
function updatePair(pid, patch, evPatch) {
  const p = pairById(pid);
  if (!p) return;
  if (state.lockMode && p.status === "confirmed") { toast("已确认双叶已锁定"); return; }
  pushUndo("编辑双叶");
  Object.assign(p, patch);
  if (evPatch) Object.assign(p.evidence, evPatch);
  afterStructural("");
}

function setStatus(kind, id, status) {
  commit(status === "confirmed" ? "标记为已确认" : "标记为存疑", () => {
    if (kind === "leaf") leafById(id).status = status;
    if (kind === "pair") pairById(id).status = status;
  });
}

function splitQuire(qId, index) {
  const q = quireById(qId);
  if (!q || quireLocked(q)) { toast("书帖已锁定"); return; }
  if (!(index > 0 && index < q.leaves.length)) { toast("不能在帖首/帖末拆开（会产生空帖）"); return; }
  // 跨拆点的双叶将被撕成跨帖 → 提示
  const crossing = q.leaves.slice(0, index).some((lid) => {
    const p = pairOf(lid);
    return p && q.leaves.slice(index).includes(p.a === lid ? p.b : p.a);
  });
  if (crossing && !confirm("拆帖位置切开了双叶嵌套，拆后将报“嵌套冲突”。继续？")) return;
  commit("拆帖：" + q.name + " @ 第" + index + "叶后", () => {
    const nq = { id: uid("q"), name: q.name + "（续）", locked: false, leaves: q.leaves.splice(index) };
    state.doc.quires.splice(state.doc.quires.indexOf(q) + 1, 0, nq);
    state.selection = { kind: "quire", id: nq.id };
  });
}

function mergeQuires(q1Id, q2Id) {
  const a = quireById(q1Id), b = quireById(q2Id);
  if (!a || !b) return;
  if (quireLocked(a) || quireLocked(b)) { toast("书帖已锁定"); return; }
  const ia = state.doc.quires.indexOf(a), ib = state.doc.quires.indexOf(b);
  if (Math.abs(ia - ib) !== 1) { toast("只能合并相邻两帖"); return; }
  commit("合帖：" + a.name + " + " + b.name, () => {
    const first = ia < ib ? a : b, second = ia < ib ? b : a;
    first.leaves.push(...second.leaves);
    first.name = first.name + "＋" + second.name.replace(/（续）/, "");
    state.doc.quires = state.doc.quires.filter((q) => q !== second);
  });
}

function toggleQuireLock(qId, locked) {
  const q = quireById(qId);
  commit(locked ? "锁定书帖 " + q.name : "解锁书帖 " + q.name, () => { q.locked = locked; });
}

function deleteQuire(qId) {
  const q = quireById(qId);
  if (!q) return;
  if (q.leaves.length && !confirm("书帖非空：其中叶件将全部移回待编区，书帖删除。继续？")) return;
  commit("删除书帖 " + q.name, () => {
    q.leaves.length = 0;
    state.doc.quires = state.doc.quires.filter((x) => x.id !== qId);
    state.selection = null;
  });
}

/* ============================================================
   校验引擎
   ============================================================ */
const ISSUE_META = {
  missing:  { name: "缺叶", sev: "err" },
  dup:      { name: "重号", sev: "err" },
  dangle:   { name: "悬空单叶", sev: "err" },
  nest:     { name: "嵌套冲突", sev: "err" },
  evidence: { name: "证据矛盾", sev: "err" },
  order:    { name: "叶序不衔接", sev: "warn" },
  occupy:   { name: "重复占位", sev: "err" },
  struct:   { name: "结构异常", sev: "warn" },
};

function validate(doc) {
  const issues = [];
  const add = (type, msg, loc, refs = {}, sev = null) =>
    issues.push({ type, sev: sev || ISSUE_META[type].sev, msg, loc, ...refs });

  /* ---- 1. 重复占位 / 引用丢失 ---- */
  const seen = new Map();
  for (const q of doc.quires) {
    for (const lid of q.leaves) {
      if (!leafByIdDoc(doc, lid)) { add("occupy", "引用了不存在的叶件", q.name, { qid: q.id }); continue; }
      if (seen.has(lid)) add("occupy", leafLabel(leafByIdDoc(doc, lid)) + " 同时占据「" +
        seen.get(lid).name + "」与「" + q.name + "」", q.name, { qid: q.id, lid });
      else seen.set(lid, q);
    }
  }

  /* ---- 2. 各帖内部层位 / 嵌套 / 悬空 / 双叶证据 ---- */
  for (const q of doc.quires) {
    const n = q.leaves.length;
    if (n === 0) { add("struct", "空书帖", q.name, { qid: q.id }); continue; }
    const center = n % 2 ? (n - 1) / 2 : -1;

    q.leaves.forEach((lid, i) => {
      const l = leafByIdDoc(doc, lid);
      const p = pairOfDoc(doc, lid);

      if (p) {
        const otherId = p.a === lid ? p.b : p.a;
        const j = q.leaves.indexOf(otherId);
        if (j < 0) {
          add("nest", "双叶跨帖：" + leafLabel(l) + " 的另一半不在本帖", q.name + " · 第" + (i + 1) + "位",
            { qid: q.id, lid, pid: p.id });
        } else if (i + j !== n - 1) {
          add("nest", "层位不对应：" + leafLabel(l) + " 与 " + leafLabel(leafByIdDoc(doc, otherId)) +
            " 不在对应层位（对应层位和应为 " + n + "）", q.name + " · 第" + (i + 1) + "位",
            { qid: q.id, lid, pid: p.id });
        }
      } else if (!l.frag) {
        // 无配对的完整叶：必须在中缝（奇数帖），或有接缝证据与邻叶相接
        const grounded = l.evidence.seam && (i > 0 || i < n - 1);
        if (i !== center && !grounded) {
          add("dangle", "悬空单叶：" + leafLabel(l) + " 既不在中缝，也无接缝证据",
            q.name + " · 第" + (i + 1) + "位", { qid: q.id, lid });
        }
        if (i === center && l.evidence.fold !== "none")
          add("evidence", "中缝单叶 " + leafLabel(l) + " 却录有折痕（折痕应属于双叶），请核对",
            q.name + " · 中缝", { qid: q.id, lid }, "warn");
      }
      // 残片不应有完整折痕
      if (l.frag && l.evidence.fold !== "none")
        add("evidence", "残片不应有完整折痕记录，请核对证据", q.name, { qid: q.id, lid }, "warn");
    });

    /* 双叶证据检查：独立于层位正确性，逐对执行一次 */
    for (const p of doc.pairs) {
      const la = leafByIdDoc(doc, p.a), lb = leafByIdDoc(doc, p.b);
      if (!la || !lb) continue;
      // 只在“持有 a 叶的帖”报告一次，避免跨帖双叶重复
      if (!q.leaves.includes(la.id)) continue;
      const qa = doc.quires.find((qq) => qq.leaves.includes(la.id));
      const qb = doc.quires.find((qq) => qq.leaves.includes(lb.id));
      if (qa && qb && qa !== qb) {
        add("nest", "双叶两叶分处不同书帖：" + leafLabel(la) + "（" + qa.name + "）⌒ " +
          leafLabel(lb) + "（" + qb.name + "）", qa.name + " / " + qb.name,
          { qid: qa.id, pid: p.id });
      }
      if (la.frag || lb.frag)
        add("evidence", "残片被配入双叶：残片通常不足以构成整张双叶（" +
          leafLabel(la) + " ⌒ " + leafLabel(lb) + "）", q.name, { qid: q.id, pid: p.id });
      if (p.status === "confirmed" && la.evidence.fold === "none" && lb.evidence.fold === "none")
        add("evidence", "双叶已确认，但两叶均无折痕证据：" + leafLabel(la) + " ⌒ " + leafLabel(lb),
          q.name, { qid: q.id, pid: p.id });
      else if (p.status === "confirmed" && (la.evidence.fold === "none" || lb.evidence.fold === "none"))
        add("evidence", "已确认双叶仅一叶有折痕记录：" + leafLabel(la) + " ⌒ " + leafLabel(lb),
          q.name, { qid: q.id, pid: p.id }, "warn");
      if (la.evidence.holes > 0 && lb.evidence.holes > 0 &&
        Math.abs(la.evidence.holes - lb.evidence.holes) > 1)
        add("evidence", "线孔数量矛盾：" + leafLabel(la) + " " + la.evidence.holes + " 孔 vs " +
          leafLabel(lb) + " " + lb.evidence.holes + " 孔", q.name, { qid: q.id, pid: p.id });
    }
  }

  /* ---- 2b. 两叶均未入帖的双叶 ---- */
  for (const p of doc.pairs) {
    const la = leafByIdDoc(doc, p.a), lb = leafByIdDoc(doc, p.b);
    if (!la || !lb) continue;
    if (seen.has(la.id) || seen.has(lb.id)) continue; // 已在帖循环中处理
    if (p.status === "confirmed" && la.evidence.fold === "none" && lb.evidence.fold === "none")
      add("evidence", "双叶已确认，但两叶均无折痕证据：" + leafLabel(la) + " ⌒ " + leafLabel(lb),
        "待编区", { pid: p.id });
  }

  /* ---- 3. 叶序：帖内与帖间连续编码，缺叶 / 重号 / 倒序 ---- */
  const global = []; // {lid, num, raw, q, pos}
  for (const q of doc.quires) {
    q.leaves.forEach((lid, pos) => {
      const l = leafByIdDoc(doc, lid);
      global.push({ lid, num: parseFolio(l.folio), raw: l.folio, q, pos });
    });
  }
  const rawCount = new Map();
  global.forEach((g) => {
    if (g.raw) rawCount.set(g.raw, (rawCount.get(g.raw) || 0) + 1);
  });
  for (const [raw, c] of rawCount) {
    if (c > 1) {
      global.filter((g) => g.raw === raw).forEach((g) =>
        add("dup", "重号：叶码「" + raw + "」出现 " + c + " 次", g.q.name + " · 第" + (g.pos + 1) + "位",
          { qid: g.q.id, lid: g.lid }));
    }
  }
  for (let i = 1; i < global.length; i++) {
    const a = global[i - 1], b = global[i];
    if (a.num == null || b.num == null) continue;
    if (b.num === a.num) continue; // 重号已单列
    if (b.num < a.num) {
      add("order", "叶序倒置：「" + a.raw + "」之后接「" + b.raw + "」",
        b.q.name + " · 第" + (b.pos + 1) + "位", { qid: b.q.id, lid: b.lid });
    } else if (b.num > a.num + 1) {
      const sameQuire = a.q === b.q;
      for (let m = a.num + 1; m < b.num; m++)
        add("missing", "缺叶：疑缺第 " + numToDisplay(m) + " 叶（" +
          (sameQuire ? "帖内" : "跨帖") + "，介于「" + a.raw + "」与「" + b.raw + "」之间）",
          (sameQuire ? a.q.name : a.q.name + " → " + b.q.name),
          { qid: sameQuire ? a.q.id : null });
    }
  }
  return issues;
}
function leafByIdDoc(doc, id) { return doc.leaves.find((l) => l.id === id); }
function pairOfDoc(doc, id) { return doc.pairs.find((p) => p.a === id || p.b === id); }
function numToDisplay(n) {
  if (n > 99) return String(n);
  const d = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) return d[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + d[n % 10];
  const t = Math.floor(n / 10), u = n % 10;
  return d[t] + "十" + (u ? d[u] : "");
}

/* 问题索引（供渲染打标） */
function issuesFor(lid, qid, pid) {
  return state.issues.filter((x) =>
    (lid && x.lid === lid) || (pid && x.pid === pid) ||
    (qid && !lid && !pid && x.qid === qid));
}
function leafIssueLevel(lid) {
  const is = state.issues.filter((x) => x.lid === lid);
  if (is.some((x) => x.sev === "err")) return "err";
  if (is.length) return "warn";
  return null;
}

/* ============================================================
   残片候选位置筛选
   ============================================================ */
function fragmentCandidates(fragId) {
  const frag = leafById(fragId);
  if (!frag) return [];
  const baseKey = (x) => [x.type, x.sev, x.qid || "", x.lid || "", x.pid || "", x.msg].join("|");
  const base = new Set(validate(state.doc).map(baseKey));
  const out = [];

  function simulate(qId, index) {
    const d = clone(state.doc);
    const fd = d.leaves.find((l) => l.id === fragId);
    d.quires.forEach((q) => (q.leaves = q.leaves.filter((x) => x !== fragId)));
    const after = validate(d); // 先算“取出残片后”
    const beforeKeys = new Set(after.map(baseKey));
    if (qId) {
      const q = d.quires.find((q) => q.id === qId);
      q.leaves.splice(Math.min(index, q.leaves.length), 0, fragId);
    } else {
      d.quires.push({ id: "newq", name: "新帖", locked: false, leaves: [fragId] });
    }
    const ins = validate(d);
    const newErrs = ins.filter((x) => x.sev === "err" && !beforeKeys.has(baseKey(x)) &&
      (x.lid === fragId || (!x.lid && (x.qid === qId))));
    return newErrs;
  }

  function justify(q, index) {
    const why = [];
    const n = q.leaves.length;
    if (frag.evidence.seam && (index > 0 || index < n)) why.push("可接缝相邻叶");
    if (frag.evidence.holes > 0) {
      const nb = [q.leaves[index - 1], q.leaves[index]].filter(Boolean).map(leafById);
      if (nb.some((l) => l.evidence.holes > 0 && Math.abs(l.evidence.holes - frag.evidence.holes) <= 1))
        why.push("线孔数相合");
    }
    const fn = parseFolio(frag.folio);
    if (fn != null) {
      const prev = leafById(q.leaves[index - 1]), next = leafById(q.leaves[index]);
      const pn = prev ? parseFolio(prev.folio) : null, nn = next ? parseFolio(next.folio) : null;
      if ((pn == null || fn === pn + 1) && (nn == null || fn === nn - 1)) why.push("叶码衔接");
    }
    const newN = n + 1;
    const center = (newN - 1) / 2;
    if (newN % 2 && index === center) why.push("可居中缝");
    return why;
  }

  for (const q of state.doc.quires) {
    if (state.lockMode && q.locked) continue; // 锁定帖不参与候选
    for (let i = 0; i <= q.leaves.length; i++) {
      const errs = simulate(q.id, i);
      if (errs.length === 0) {
        const why = justify(q, i);
        out.push({
          qId: q.id, qName: q.name, index: i,
          pos: i === 0 ? "帖首" : i === q.leaves.length ? "帖末（第" + i + "叶后）" : "第" + i + "叶与第" + (i + 1) + "叶之间",
          why, weak: why.length === 0,
        });
      }
    }
  }
  // 新建书帖：单残片独立成帖，结构上是中缝单叶，恒可行但证据弱
  out.push({ qId: null, qName: "新建书帖", index: 0, pos: "独立成帖（中缝单叶 / 待以后配补）",
    why: frag.evidence.seam ? ["可另立护叶帖"] : [], weak: true, newQuire: true });

  out.sort((a, b) => b.why.length - a.why.length);
  return out;
}

function placeCandidate(fragId, c) {
  if (c.newQuire) {
    commit("候选：残片独立成帖", () => {
      const q = { id: uid("q"), name: "帖" + (state.doc.quires.length + 1), locked: false, leaves: [fragId] };
      state.doc.quires.push(q);
    });
  } else {
    if (!ensureNotLocked(fragId)) return;
    const dst = quireById(c.qId);
    if (quireLocked(dst)) { toast("书帖已锁定"); return; }
    commit("采纳候选：置入「" + c.qName + "」" + c.pos, () => {
      state.doc.quires.forEach((q) => (q.leaves = q.leaves.filter((x) => x !== fragId)));
      dst.leaves.splice(Math.min(c.index, dst.leaves.length), 0, fragId);
    });
  }
}

/* ============================================================
   渲染
   ============================================================ */
const PAIR_COLORS = ["#8c4a2f", "#35609b", "#3e7d4f", "#7a4fa3", "#b58a3c", "#9b3557", "#2f7d7a", "#a35d2f"];
function pairColorInQuire(q, pid) {
  const ordered = [];
  q.leaves.forEach((lid) => {
    const p = pairOf(lid);
    if (p && !ordered.includes(p.id)) ordered.push(p.id);
  });
  return PAIR_COLORS[ordered.indexOf(pid) % PAIR_COLORS.length];
}

function statusMarks(l) {
  const lv = leafIssueLevel(l.id);
  const parts = [];
  if (lv === "err") parts.push('<span title="存在冲突">❗</span>');
  if (l.status === "doubt") parts.push('<span title="存疑">？</span>');
  if (leafLocked(l.id)) parts.push('<span title="锁定">🔒</span>');
  return parts.length ? `<span class="sl-mark">${parts.join("")}</span>` : "";
}

function renderAll() {
  renderTray();
  renderSection();
  renderStrip();
  renderCards();
  renderDetail();
  renderIssues();
  renderCandidates();
  renderLegend();
  syncViewTabs();
}

function renderLegend() {
  $("#legendInline").innerHTML = [
    '<span><i style="border-color:#8c4a2f"></i>双叶嵌套弧</span>',
    '<span><i style="border-color:#b58a3c"></i>线孔证据</span>',
    '<span><i style="border-color:#35609b"></i>接缝/托裱</span>',
    '<span><i style="border-color:#8c4a2f;border-top-style:dashed"></i>折痕</span>',
    '<span>┄ 存疑</span>',
    '<span style="color:#b3382c">◉ 冲突</span>',
    '<span style="color:#3e7d4f">🔒 锁定</span>',
  ].join("");
}

function renderTray() {
  const placed = new Set();
  state.doc.quires.forEach((q) => q.leaves.forEach((x) => placed.add(x)));
  const unplaced = state.doc.leaves.filter((l) => !placed.has(l.id));
  $("#unplacedCount").textContent = unplaced.length;
  $("#tray").innerHTML = unplaced.length
    ? unplaced.map((l) => {
      const p = pairOf(l.id);
      return `<div class="tray-item ${state.selection?.kind === "leaf" && state.selection.id === l.id ? "selected" : ""}"
        draggable="true" data-leaf="${l.id}">
        <span class="ti-kind ${l.frag ? "frag" : p ? "" : "single"}">${l.frag ? "残" : p ? "双" : "单"}</span>
        <span>${esc(leafLabel(l))}</span>
        ${l.status === "doubt" ? '<span style="color:#c47f1a;margin-left:auto">疑</span>' : ""}
      </div>`;
    }).join("")
    : '<p class="muted">（无）</p>';
}

/* ---------------- 嵌套剖面 SVG ---------------- */
function sectionSVG(q) {
  const n = q.leaves.length;
  const slotW = 40, gap = 8, pad = 20;
  const W = Math.max(220, pad * 2 + n * slotW + (n - 1) * gap);
  const maxLayer = Math.ceil(n / 2);
  const arcBase = 26, arcStep = 17;
  const slotY = arcBase + maxLayer * arcStep + 18;
  const slotH = 88;
  const H = slotY + slotH + 30;
  const cx = (i) => pad + i * (slotW + gap) + slotW / 2;

  let s = `<svg class="sec-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-quire="${q.id}">`;
  s += `<text class="sec-quire-label" x="8" y="14">${esc(q.name)}${q.locked ? " 🔒" : ""}（${n} 叶）</text>`;

  // 书脊折线
  const midX = n ? (cx(0) + cx(n - 1)) / 2 : W / 2;
  s += `<line class="sec-spine" x1="${midX}" y1="${slotY - 8}" x2="${midX}" y2="${slotY + slotH + 6}"/>`;
  if (n % 2 === 1) {
    const m = (n - 1) / 2;
    s += `<line class="sec-centerline" x1="${cx(m)}" y1="${slotY - 4}" x2="${cx(m)}" y2="${slotY + slotH + 4}"/>
          <polygon points="${cx(m) - 4},${slotY - 12} ${cx(m) + 4},${slotY - 12} ${cx(m)},${slotY - 5}" fill="#bbb0a0"/>`;
  }

  // 双叶弧
  const drawnPairs = new Set();
  q.leaves.forEach((lid, i) => {
    const p = pairOf(lid);
    if (!p || drawnPairs.has(p.id)) return;
    const j = q.leaves.indexOf(p.a === lid ? p.b : p.a);
    if (j < 0) return;
    drawnPairs.add(p.id);
    const lo = Math.min(i, j), hi = Math.max(i, j);
    const layer = Math.min(lo, n - 1 - hi) + 1;
    const rh = arcBase + layer * arcStep;
    const col = pairColorInQuire(q, p.id);
    const doubt = p.status === "doubt" ? " doubt-dash" : "";
    const iss = issuesFor(null, null, p.id).length ? ' stroke="#b3382c"' : "";
    s += `<path d="M ${cx(lo)} ${slotY} C ${cx(lo)} ${slotY - rh * 1.25}, ${cx(hi)} ${slotY - rh * 1.25}, ${cx(hi)} ${slotY}"
      fill="none" stroke="rgba(0,0,0,0)" stroke-width="10" style="cursor:pointer" data-pair="${p.id}"/>`;
    s += `<path d="M ${cx(lo)} ${slotY} C ${cx(lo)} ${slotY - rh * 1.25}, ${cx(hi)} ${slotY - rh * 1.25}, ${cx(hi)} ${slotY}"
      class="pair-arc${doubt}" fill="none"${iss || ` stroke="${col}"`} stroke-width="2.4" style="pointer-events:none"/>`;
    s += `<text x="${(cx(lo) + cx(hi)) / 2}" y="${slotY - rh + 3}" text-anchor="middle"
      style="font-size:9px;font-family:sans-serif;fill:${iss ? "#b3382c" : col}">第${layer}层${doubt ? " 疑" : ""}</text>`;
  });

  // 叶槽
  q.leaves.forEach((lid, i) => {
    const l = leafById(lid);
    const p = pairOf(lid);
    const x = pad + i * (slotW + gap);
    const sel = state.selection?.kind === "leaf" && state.selection.id === lid ? " sec-selected-slot" : "";
    const gStart = s.length;
    s += `<rect class="sec-slot${sel}" x="${x}" y="${slotY}" width="${slotW}" height="${slotH}" rx="3"/>`;

    // 线孔（靠书脊一侧，即朝向中轴的边）
    const holes = Math.min(5, l.evidence.holes || 0);
    const innerSide = cx(i) < midX ? x + slotW - 3 : x + 3;
    for (let h = 0; h < holes; h++) {
      const hy = slotY + 16 + h * 13;
      s += `<circle class="sec-hole" cx="${innerSide}" cy="${hy}" r="2.2"/>`;
    }
    // 折痕标记
    if (l.evidence.fold !== "none") {
      const fx = cx(i) < midX ? x + 5 : x + slotW - 5;
      s += `<path class="sec-fold-mark ${l.status === "doubt" ? "doubt-dash" : ""}"
        d="M ${fx - 3} ${slotY + 8} l 3 5 l 3 -5"/>`;
    }
    // 接缝：槽间蓝条
    if (l.evidence.seam && !p && i > 0) {
      s += `<rect class="sec-join" x="${x - gap / 2 - 1}" y="${slotY + 10}" width="2.5" height="${slotH - 20}"/>`;
    }

    const fol = l.folio ? esc(l.folio) : (l.frag ? "残" : "—");
    s += `<text class="sec-folio ${l.frag ? "sec-frag" : ""}" x="${cx(i)}" y="${slotY + slotH / 2 + 1}">${fol}</text>`;
    s += `<text x="${cx(i)}" y="${slotY + slotH / 2 + 15}" text-anchor="middle"
      style="font-size:9px;font-family:sans-serif;fill:#8a7f6f">${l.frag ? "残片" : p ? "双" : "单"}</text>`;
    const lv = leafIssueLevel(lid);
    if (lv) s += `<circle class="issue-ring" cx="${x + 6}" cy="${slotY + 7}" r="4"/>
      <text class="issue-mark" x="${x + 6}" y="${slotY + 10.5}" text-anchor="middle">!</text>`;
    // 整槽包进 <g>，使文字/标记点击都能选中该叶
    const inner = s.slice(gStart);
    s = s.slice(0, gStart) + `<g data-leaf="${lid}" style="cursor:pointer">${inner}</g>`;
  });

  // 放置热区（槽间）
  for (let i = 0; i <= n; i++) {
    const x = i === 0 ? pad - 5 : pad + i * (slotW + gap) - gap / 2 - 4;
    s += `<rect class="sec-drop" data-q="${q.id}" data-i="${i}" x="${x}" y="${slotY - 6}"
      width="10" height="${slotH + 12}" fill="transparent" style="cursor:copy"/>`;
  }
  s += `</svg>`;
  return s;
}

function renderSection() {
  const el = $("#sectionView");
  if (!state.doc.quires.length) {
    el.innerHTML = '<p class="muted" style="padding:20px">尚无书帖。从左侧「新书帖」开始，或把叶件拖到此处。</p>';
    return;
  }
  el.innerHTML = state.doc.quires.map(sectionSVG).join('<span style="display:inline-block;width:24px"></span>');
}

/* ---------------- 叶序带 ---------------- */
function renderStrip() {
  const box = $("#stripView");
  if (!state.doc.quires.length) { box.innerHTML = ""; return; }
  let html = '<div class="strip-inner">';
  state.doc.quires.forEach((q, qi) => {
    html += `<div class="strip-quire ${q.locked ? "locked" : ""}" data-quire="${q.id}">
      <div class="strip-qhead" data-quire="${q.id}">
        ${q.locked ? '<span class="lock">🔒</span>' : ""}<span>${esc(q.name)}</span>
        <span style="color:#a99d8b">(${q.leaves.length})</span>
      </div>
      <div class="strip-qbody">`;
    q.leaves.forEach((lid, i) => {
      const l = leafById(lid), p = pairOf(lid);
      html += `<div class="strip-gap ${state.splitMode ? "split-on" : ""}" data-q="${q.id}" data-i="${i}"
        title="${state.splitMode ? "点击在此拆帖" : "放置到该位置前"}">${state.splitMode ? "✂" : "▏"}</div>`;
      const cls = ["strip-leaf", l.frag ? "frag" : "", p ? "" : "single"].join(" ");
      html += `<div class="${cls} ${state.selection?.kind === "leaf" && state.selection.id === lid ? "selected" : ""}"
        draggable="${leafLocked(lid) ? "false" : "true"}" data-leaf="${lid}">
        ${statusMarks(l)}
        <div class="sl-folio">${l.folio ? esc(l.folio) : (l.frag ? "残" : "—")}</div>
        <div class="sl-kind">${l.frag ? "残片" : p ? "双叶" : "单叶"}</div>
      </div>`;
    });
    html += `<div class="strip-gap" data-q="${q.id}" data-i="${q.leaves.length}"
      title="放置到帖末">${state.splitMode ? "✂" : "▏"}</div>`;
    html += `</div></div>`;
    if (qi < state.doc.quires.length - 1) {
      const q2 = state.doc.quires[qi + 1];
      html += `<div class="strip-quire-join" data-q1="${q.id}" data-q2="${q2.id}"
        title="${state.mergeMode ? "点击合并两帖" : "相邻书帖（合帖模式下可合并）"}"}">${state.mergeMode ? "⇄合" : "○"}</div>`;
    }
  });
  html += "</div>";
  box.innerHTML = html;
}

/* ---------------- 书帖卡 ---------------- */
function layerLabel(q, lid, i) {
  const n = q.leaves.length;
  const p = pairOf(lid);
  if (n % 2 && i === (n - 1) / 2) return "中缝单叶";
  if (p) {
    const j = q.leaves.indexOf(p.a === lid ? p.b : p.a);
    if (j >= 0 && i + j === n - 1) return "第 " + (Math.min(i, j) + 1) + " 层";
  }
  return "层位未定";
}

function renderCards() {
  const box = $("#cardsView");
  if (!state.doc.quires.length) { box.innerHTML = '<p class="muted">尚无书帖。</p>'; return; }
  box.innerHTML = state.doc.quires.map((q) => {
    const qerr = state.issues.some((x) => x.qid === q.id && x.sev === "err");
    const body = q.leaves.length ? q.leaves.map((lid, i) => {
      const l = leafById(lid), p = pairOf(lid);
      const lv = leafIssueLevel(lid);
      const ev = [];
      if (l.evidence.fold !== "none") ev.push("折痕·" + (l.evidence.fold === "outer" ? "外" : "内"));
      if (l.evidence.seam) ev.push("接缝");
      if (l.evidence.holes) ev.push(l.evidence.holes + "孔");
      if (p) ev.push(p.status === "confirmed" ? "配叶✓" : "配叶疑");
      return `<div class="qc-slot ${state.selection?.kind === "leaf" && state.selection.id === lid ? "selected" : ""}"
        draggable="${leafLocked(lid) ? "false" : "true"}" data-leaf="${lid}">
        <span class="qc-layer">${layerLabel(q, lid, i)}</span>
        <span class="qc-folio">${l.folio ? esc(l.folio) : (l.frag ? "残片" : "—")}</span>
        <span class="qc-ev">${ev.map(esc).join("，")}</span>
        <span class="qc-badges">
          ${l.frag ? '<span class="mini-bad violet">残</span>' : ""}
          ${l.status === "doubt" ? '<span class="mini-bad warn">疑</span>' : '<span class="mini-bad ok">确</span>'}
          ${lv === "err" ? '<span class="mini-bad err">!</span>' : ""}
        </span>
        <button class="qc-x" data-tray="${lid}" title="移回待编区">×</button>
      </div>`;
    }).join("") : '<div class="qc-slot empty">空帖 —— 可从待编区拖入</div>';
    return `<div class="quire-card ${q.locked ? "locked" : ""}" data-quire="${q.id}">
      <div class="qc-head">
        <input type="text" value="${esc(q.name)}" data-qname="${q.id}" ${state.lockMode && q.locked ? "disabled" : ""}>
        <span class="qc-status" style="color:${qerr ? "#b3382c" : "#3e7d4f"}">${qerr ? "● 有冲突" : "● 自洽"}</span>
      </div>
      <div class="qc-body">${body}
        <div class="qc-slot empty sec-drop" data-q="${q.id}" data-i="${q.leaves.length}"
          style="cursor:copy">＋ 放置到帖末</div>
      </div>
      <div class="qc-foot">
        <button data-splitq="${q.id}">✂ 拆帖…</button>
        <button data-mergeq="${q.id}">⇄ 与邻帖合并…</button>
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" data-qlock="${q.id}" ${q.locked ? "checked" : ""}> 锁定已确认关系</label>
        <button data-delq="${q.id}" style="margin-left:auto;color:#b3382c">删除帖</button>
      </div>
    </div>`;
  }).join("");
}

/* ---------------- 详情面板 ---------------- */
function renderDetail() {
  const box = $("#tab-detail");
  const sel = state.selection;
  if (!sel) {
    box.innerHTML = `<div id="detailBox"><p class="muted">点选任一叶件 / 双叶弧 / 书帖标题查看详情。</p>
      <div class="detail-section"><h3>卷子信息</h3>
        <div class="field"><label>题名</label><input type="text" id="docTitle" value="${esc(state.doc.title)}"></div>
        <div class="field"><label>备注</label><textarea id="docNotes">${esc(state.doc.notes || "")}</textarea></div>
      </div></div>`;
    $("#docTitle")?.addEventListener("change", (e) => { state.doc.title = e.target.value; markDirty(); });
    $("#docNotes")?.addEventListener("change", (e) => { state.doc.notes = e.target.value; markDirty(); });
    return;
  }
  if (sel.kind === "leaf") {
    const l = leafById(sel.id);
    if (!l) { state.selection = null; return renderDetail(); }
    const q = quireOf(l.id), p = pairOf(l.id);
    const others = state.doc.leaves.filter((x) => x.id !== l.id && !pairOf(x.id));
    box.innerHTML = `<div id="detailBox">
      <div class="detail-section">
        <h3>叶件 ${esc(leafLabel(l))} ${l.frag ? '<span class="mini-bad violet">残片</span>' : ""}</h3>
        <div class="status-pick">
          <button data-st="confirmed" class="${l.status === "confirmed" ? "on-conf" : ""}">✓ 已确认</button>
          <button data-st="doubt" class="${l.status === "doubt" ? "on-doubt" : ""}">？存疑</button>
        </div>
      </div>
      <div class="detail-section">
        <h3>著录</h3>
        <div class="field"><label>叶码</label><input type="text" id="fFolio" value="${esc(l.folio)}"
          placeholder="如 十二 / 12 / 卷二·三"></div>
        <div class="field"><label>正面（阳）</label><input type="text" id="fRecto" value="${esc(l.faces?.recto || "")}"
          placeholder="正面文字 / 版心题记"></div>
        <div class="field"><label>背面（阴）</label><input type="text" id="fVerso" value="${esc(l.faces?.verso || "")}"
          placeholder="背面文字 / 题跋"></div>
        <label class="field check"><input type="checkbox" id="fFrag" ${l.frag ? "checked" : ""}>
          该件为残片（不参与双叶强校验，由候选系统筛位）</label>
      </div>
      <div class="detail-section">
        <h3>证据</h3>
        <div class="field"><label>折痕</label>
          <select id="fFold">
            <option value="none" ${l.evidence.fold === "none" ? "selected" : ""}>无折痕证据</option>
            <option value="outer" ${l.evidence.fold === "outer" ? "selected" : ""}>外折（板框朝外）</option>
            <option value="inner" ${l.evidence.fold === "inner" ? "selected" : ""}>内折（板框朝内）</option>
          </select></div>
        <label class="field check"><input type="checkbox" id="fSeam" ${l.evidence.seam ? "checked" : ""}>
          有接缝/托裱证据（与邻叶相接，可使单叶成立）</label>
        <div class="field"><label>线孔数</label><input type="number" min="0" max="12" id="fHoles"
          value="${l.evidence.holes || 0}"></div>
        <div class="field"><label>备注</label><textarea id="fNote">${esc(l.note || "")}</textarea></div>
      </div>
      <div class="detail-section">
        <h3>配叶关系</h3>
        ${p ? `<p style="font-size:12px">属于双叶：<a href="#" data-gopair="${p.id}" style="color:#8c4a2f">
          ${esc(leafLabel(leafById(p.a)))} ⌒ ${esc(leafLabel(leafById(p.b)))}</a></p>` : `
        <div class="field pair-pick"><label>配成</label>
          <select id="pairWith"><option value="">— 选择另一半叶 —</option>
            ${others.map((o) => `<option value="${o.id}">${esc(leafLabel(o))}</option>`).join("")}
          </select><button class="btn small" id="doPair" style="color:#fff">配对</button></div>`}
      </div>
      <div class="detail-section detail-actions">
        <button class="btn ghost" id="btnTray" style="color:#8c4a2f;border-color:#8c4a2f">移回待编区</button>
        <button class="btn danger" id="btnDelLeaf">删除叶件</button>
      </div>
      <p class="muted">所在：${q ? esc(q.name) + " · 第 " + (q.leaves.indexOf(l.id) + 1) + " 位" : "待编区"}</p>
    </div>`;

    $("#tab-detail").querySelectorAll("[data-st]").forEach((b) =>
      b.onclick = () => setStatus("leaf", l.id, b.dataset.st));
    $("#fFolio")?.addEventListener("change", (e) => updateLeaf(l.id, { folio: e.target.value.trim() }));
    $("#fRecto")?.addEventListener("change", (e) => updateLeaf(l.id, { faces: { ...l.faces, recto: e.target.value } }));
    $("#fVerso")?.addEventListener("change", (e) => updateLeaf(l.id, { faces: { ...l.faces, verso: e.target.value } }));
    $("#fFrag")?.addEventListener("change", (e) => updateLeaf(l.id, { frag: e.target.checked }));
    $("#fFold")?.addEventListener("change", (e) => updateLeaf(l.id, {}, { fold: e.target.value }));
    $("#fSeam")?.addEventListener("change", (e) => updateLeaf(l.id, {}, { seam: e.target.checked }));
    $("#fHoles")?.addEventListener("change", (e) => updateLeaf(l.id, {}, { holes: Math.max(0, +e.target.value || 0) }));
    $("#fNote")?.addEventListener("change", (e) => updateLeaf(l.id, { note: e.target.value }));
    $("#doPair")?.addEventListener("click", () => { const v = $("#pairWith").value; if (v) makePair(l.id, v); });
    $("#btnTray")?.addEventListener("click", () => sendToTray(l.id));
    $("#btnDelLeaf")?.addEventListener("click", () => deleteLeaf(l.id));
    $("#tab-detail").querySelectorAll("[data-gopair]").forEach((a) =>
      a.onclick = (e) => { e.preventDefault(); state.selection = { kind: "pair", id: a.dataset.gopair }; renderAll(); });
  }

  if (sel.kind === "pair") {
    const p = pairById(sel.id);
    if (!p) { state.selection = null; return renderDetail(); }
    const la = leafById(p.a), lb = leafById(p.b), q = quireOf(p.a);
    box.innerHTML = `<div id="detailBox">
      <div class="detail-section"><h3>双叶（bifolio）</h3>
        <p style="font-size:13px"><a href="#" data-go="${p.a}" style="color:#8c4a2f">${esc(leafLabel(la))}</a>
          <span style="color:#8c4a2f"> ⌒ </span>
          <a href="#" data-go="${p.b}" style="color:#8c4a2f">${esc(leafLabel(lb))}</a></p>
        <div class="status-pick" style="margin-top:8px">
          <button data-st="confirmed" class="${p.status === "confirmed" ? "on-conf" : ""}">✓ 已确认</button>
          <button data-st="doubt" class="${p.status === "doubt" ? "on-doubt" : ""}">？存疑</button>
        </div>
      </div>
      <div class="detail-section"><h3>装订证据</h3>
        <label class="field check"><input type="checkbox" id="pJoin" ${p.evidence.join ? "checked" : ""}>
          折缝相连 / 原为一张纸（纸张连续证据）</label>
        <label class="field check"><input type="checkbox" id="pThread" ${p.evidence.threadMatch ? "checked" : ""}>
          两叶线孔位置相合（针脚证据）</label>
      </div>
      <div class="detail-section detail-actions">
        <button class="btn ghost" id="btnBreak" style="color:#b3382c;border-color:#b3382c">解除配叶（拆为两单叶）</button>
      </div>
      <p class="muted">所在：${q ? esc(q.name) : "两叶不在同一帖 / 待编"}</p>
    </div>`;
    $("#tab-detail").querySelectorAll("[data-st]").forEach((b) =>
      b.onclick = () => setStatus("pair", p.id, b.dataset.st));
    $("#pJoin").onchange = (e) => updatePair(p.id, {}, { join: e.target.checked });
    $("#pThread").onchange = (e) => updatePair(p.id, {}, { threadMatch: e.target.checked });
    $("#btnBreak").onclick = () => breakPair(p.id);
    $("#tab-detail").querySelectorAll("[data-go]").forEach((a) =>
      a.onclick = (e) => { e.preventDefault(); state.selection = { kind: "leaf", id: a.dataset.go }; renderAll(); });
  }

  if (sel.kind === "quire") {
    const q = quireById(sel.id);
    if (!q) { state.selection = null; return renderDetail(); }
    const adj = state.doc.quires.map((x, i) => ({ x, i })).filter(({ x, i }) =>
      Math.abs(i - state.doc.quires.indexOf(q)) === 1);
    box.innerHTML = `<div id="detailBox">
      <div class="detail-section"><h3>书帖 ${esc(q.name)}</h3>
        <div class="field"><label>帖名</label><input type="text" id="qName" value="${esc(q.name)}"></div>
        <label class="field check"><input type="checkbox" id="qLock" ${q.locked ? "checked" : ""}>
          锁定本帖已确认的装订关系</label>
        <p class="muted">叶数：${q.leaves.length}（${q.leaves.length % 2 ? "奇数帖，中缝应有一单叶" : "偶数帖，全由双叶嵌套"}）</p>
      </div>
      <div class="detail-section"><h3>拆 / 合</h3>
        <div class="field"><label>拆帖位置</label>
          <select id="splitAt"><option value="">—</option>
            ${q.leaves.map((lid, i) => i > 0 ? `<option value="${i}">第 ${i} 叶之后</option>` : "").join("")}
          </select><button class="btn small" id="doSplit" style="color:#fff">拆开</button></div>
        ${adj.length ? `<div class="field"><label>合并</label>
          <select id="mergeWith"><option value="">— 选择相邻帖 —</option>
            ${adj.map(({ x }) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}
          </select><button class="btn small" id="doMerge" style="color:#fff">合并</button></div>` : ""}
      </div>
      <div class="detail-section detail-actions">
        <button class="btn danger" id="doDelQ">删除书帖${q.leaves.length ? "（叶件回待编区）" : ""}</button>
      </div></div>`;
    $("#qName").onchange = (e) => { pushUndo("改帖名"); q.name = e.target.value; afterStructural(""); };
    $("#qLock").onchange = (e) => toggleQuireLock(q.id, e.target.checked);
    $("#doSplit").onclick = () => { const v = +$("#splitAt").value; if (v) splitQuire(q.id, v); };
    $("#doMerge")?.addEventListener("click", () => { const v = $("#mergeWith").value; if (v) mergeQuires(q.id, v); });
    $("#doDelQ").onclick = () => deleteQuire(q.id);
  }
}

/* ---------------- 候选面板 ---------------- */
function renderCandidates() {
  const box = $("#candidateBox");
  const sel = state.selection;
  if (!sel || sel.kind !== "leaf" || !leafById(sel.id)?.frag) {
    box.innerHTML = '<span class="muted">请选中一片残片…</span>';
    return;
  }
  const frag = leafById(sel.id);
  const cands = fragmentCandidates(frag.id);
  box.innerHTML = `<div style="font-size:11px;color:#6b6156;font-family:sans-serif;margin-bottom:4px">
    ${esc(leafLabel(frag))}：共 ${cands.length} 个不冲突位置，并列保留，不自动定案</div>` +
    cands.map((c, i) => `<div class="cand-item ${c.weak ? "weak" : ""}" data-ci="${i}">
      <b>${c.newQuire ? "✚ " : ""}${esc(c.qName)}</b> · ${esc(c.pos)}
      ${c.why.length ? `<div class="cand-why">证据支持：${c.why.map(esc).join("、")}</div>`
        : '<div class="cand-why">无直接证据支持（仅不冲突）</div>'}
    </div>`).join("");
  box.querySelectorAll("[data-ci]").forEach((d) =>
    d.onclick = () => placeCandidate(frag.id, cands[+d.dataset.ci]));
}

/* ---------------- 问题面板 ---------------- */
function renderIssues() {
  $("#issueCount").textContent = state.issues.filter((x) => x.sev === "err").length;
  const f = $("#issueFilters");
  const types = [...new Set(state.issues.map((x) => x.type))];
  if (!f.dataset.init) {
    f.dataset.init = "1";
    f.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state.issueFilter.has(b.dataset.t) ? state.issueFilter.delete(b.dataset.t) : state.issueFilter.add(b.dataset.t);
      renderIssues();
    });
  }
  f.innerHTML = Object.keys(ISSUE_META).filter((t) => types.includes(t)).map((t) => {
    const c = state.issues.filter((x) => x.type === t).length;
    const off = state.issueFilter.has(t) ? " off" : "";
    return `<button data-t="${t}" class="${off}">${ISSUE_META[t].name} ${c}</button>`;
  }).join("");

  const list = state.issues.filter((x) => !state.issueFilter.has(x.type));
  const box = $("#issuesBox");
  if (!list.length) {
    box.innerHTML = '<div style="padding:14px;text-align:center;color:#3e7d4f;font-size:13px">✓ 当前复原方案未见冲突</div>';
    return;
  }
  box.innerHTML = Object.keys(ISSUE_META).map((t) => {
    const rows = list.filter((x) => x.type === t);
    if (!rows.length) return "";
    return `<div class="issue-group"><h3>${ISSUE_META[t].name}（${rows.length}）</h3>` +
      rows.map((x) => `<div class="issue-row ${t}" data-focus='${JSON.stringify({ qid: x.qid, lid: x.lid, pid: x.pid })}'>
        <span class="ir-dot"></span><span>${esc(x.msg)}<span class="ir-loc">${esc(x.loc || "")}</span></span>
      </div>`).join("") + "</div>";
  }).join("");
  box.querySelectorAll("[data-focus]").forEach((r) =>
    r.onclick = () => {
      const f = JSON.parse(r.dataset.focus);
      if (f.lid) state.selection = { kind: "leaf", id: f.lid };
      else if (f.pid) state.selection = { kind: "pair", id: f.pid };
      else if (f.qid) state.selection = { kind: "quire", id: f.qid };
      setView("all");
      renderAll();
    });
}

/* ---------------- 视图切换 ---------------- */
function setView(v) {
  state.view = v;
  syncViewTabs();
}
function syncViewTabs() {
  const v = state.view;
  $("#sectionWrap").style.display = (v === "all" || v === "section") ? "flex" : "none";
  $("#stripWrap").style.display = (v === "all" || v === "strip") ? "flex" : "none";
  $("#cardsWrap").style.display = (v === "all" || v === "cards") ? "flex" : "none";
  $$(".vtab").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
}

/* ============================================================
   拖拽
   ============================================================ */
const drag = { type: null, payload: null };

document.addEventListener("dragstart", (e) => {
  const leafEl = e.target.closest("[data-leaf]");
  const tool = e.target.closest("[data-new]");
  if (leafEl) { drag.type = "leaf"; drag.payload = leafEl.dataset.leaf; e.dataTransfer.effectAllowed = "move"; }
  else if (tool) { drag.type = "new"; drag.payload = tool.dataset.new; e.dataTransfer.effectAllowed = "copy"; }
  else return;
  e.dataTransfer.setData("text/plain", drag.type + ":" + drag.payload);
});

function bindDropZone(container) {
  container.addEventListener("dragover", (e) => {
    const z = e.target.closest("[data-q][data-i]");
    if (!z) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = drag.type === "new" ? "copy" : "move";
    container.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
    z.classList.add("drag-over");
  });
  container.addEventListener("dragleave", (e) => {
    if (e.target.classList?.contains("drag-over")) e.target.classList.remove("drag-over");
  });
  container.addEventListener("drop", (e) => {
    const z = e.target.closest("[data-q][data-i]");
    container.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over"));
    if (!z) return;
    e.preventDefault();
    const qId = z.dataset.q, i = +z.dataset.i;
    if (drag.type === "new") {
      const kind = drag.payload === "bifolio" ? "bifolio" : drag.payload === "single" ? "single" : "frag";
      addLeaf(kind, qId, i);
    } else if (drag.type === "leaf") {
      moveLeaf(drag.payload, qId, i);
    }
  });
}
bindDropZone($("#stripView"));
bindDropZone($("#sectionView"));
bindDropZone($("#cardsView"));

/* ---------------- 工具箱点击（也可拖拽到具体位置） ---------------- */
$$("[data-new]").forEach((b) => b.addEventListener("click", () => addLeaf(b.dataset.new)));
$("#btnAddQuire").addEventListener("click", addQuire);

/* ============================================================
   全局点击委托（选择、拆合帖、卡内按钮）
   ============================================================ */
document.addEventListener("click", (e) => {
  // 候选/问题之外的选择
  const join = e.target.closest("[data-q1][data-q2]");
  if (join) {
    if (state.mergeMode) mergeQuires(join.dataset.q1, join.dataset.q2);
    return;
  }
  const gap = e.target.closest(".strip-gap");
  if (gap && state.splitMode) { splitQuire(gap.dataset.q, +gap.dataset.i); return; }

  const trayBtn = e.target.closest("[data-tray]");
  if (trayBtn) { e.stopPropagation(); sendToTray(trayBtn.dataset.tray); return; }

  const btn = e.target.closest("[data-splitq],[data-mergeq],[data-delq]");
  if (btn) {
    e.stopPropagation();
    if (btn.dataset.splitq) { state.splitMode = true; setModeMsg("拆帖模式：点击叶序带中的 ✂ 位置"); toast("点击叶序带中的剪刀标记进行拆帖"); setModeButtons(); }
    if (btn.dataset.delq) deleteQuire(btn.dataset.delq);
    if (btn.dataset.mergeq) {
      const q = quireById(btn.dataset.mergeq);
      const idx = state.doc.quires.indexOf(q);
      const adj = [state.doc.quires[idx - 1], state.doc.quires[idx + 1]].filter(Boolean);
      if (!adj.length) return toast("没有相邻书帖");
      const pick = prompt("与哪一帖合并？\n" + adj.map((x, i) => (i + 1) + ". " + x.name).join("\n"), "1");
      const k = +pick - 1;
      if (adj[k]) mergeQuires(q.id, adj[k].id);
    }
    return;
  }
  const lockCb = e.target.closest("[data-qlock]");
  if (lockCb) { toggleQuireLock(lockCb.dataset.qlock, lockCb.checked); return; }
  const qname = e.target.closest("[data-qname]");
  if (qname) return;

  const pairEl = e.target.closest("[data-pair]");
  if (pairEl) { state.selection = { kind: "pair", id: pairEl.dataset.pair }; renderAll(); switchRightTab("detail"); return; }
  const leafEl = e.target.closest("[data-leaf]");
  if (leafEl) { state.selection = { kind: "leaf", id: leafEl.dataset.leaf }; renderAll(); switchRightTab("detail"); return; }
  const qEl = e.target.closest("[data-quire]");
  if (qEl) { state.selection = { kind: "quire", id: qEl.dataset.quire }; renderAll(); switchRightTab("detail"); }
});

document.addEventListener("change", (e) => {
  if (e.target.matches("[data-qname]")) {
    const q = quireById(e.target.dataset.qname);
    pushUndo("改帖名"); q.name = e.target.value; afterStructural("");
  }
});

/* ---------------- 右栏标签 ---------------- */
function switchRightTab(t) {
  $$(".rtab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $$(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t));
}
$$(".rtab").forEach((b) => b.onclick = () => switchRightTab(b.dataset.tab));
$$(".vtab").forEach((b) => b.onclick = () => setView(b.dataset.view));

/* ---------------- 模式开关 ---------------- */
function setModeButtons() {
  $("#btnSplitMode").classList.toggle("on-conf", state.splitMode);
  $("#btnMerge").classList.toggle("on-conf", state.mergeMode);
  renderStrip();
}
function setModeMsg(t) { $("#modeMsg").textContent = t || ""; }
$("#lockMode").onchange = (e) => {
  state.lockMode = e.target.checked;
  setModeMsg(state.lockMode ? "已锁定已确认叶件 / 双叶 / 书帖，仅可操作存疑项" : "");
  renderAll();
};
$("#btnSplitMode").onclick = () => {
  state.splitMode = !state.splitMode;
  if (state.splitMode) state.mergeMode = false;
  setModeMsg(state.splitMode ? "拆帖模式：点击叶序带中的 ✂ 位置（再次点击按钮退出）" : "");
  setModeButtons();
};
$("#btnMerge").onclick = () => {
  state.mergeMode = !state.mergeMode;
  if (state.mergeMode) state.splitMode = false;
  setModeMsg(state.mergeMode ? "合帖模式：点击两帖之间的 ⇄合 圆钮（再次点击退出）" : "");
  setModeButtons();
};

/* ============================================================
   假设：保存 / 切换 / 删除
   ============================================================ */
async function refreshHypos(keepSel) {
  state.hypos = await api.list();
  renderHypoUI();
  renderHyposList();
}
function renderHypoUI() {
  const sel = $("#hypoSelect");
  sel.innerHTML = '<option value="">— 未保存的工作稿 —</option>' +
    state.hypos.map((h) => `<option value="${h.id}" ${state.meta?.id === h.id ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  if (state.meta) { $("#hypoName").value = state.meta.name; }
}
async function loadHypo(id) {
  if (state.dirty && !confirm("当前有未保存修改，切换将丢失。继续？")) { renderHypoUI(); return; }
  const h = await api.get(id);
  state.doc = normalize(h.data);
  state.meta = { id: h.id, name: h.name, updated_at: h.updated_at };
  state.selection = null;
  undoStack.length = redoStack.length = 0;
  state.dirty = false;
  $("#dirtyLine").classList.add("hidden");
  state.issues = validate(state.doc);
  renderHypoUI();
  renderAll();
  toast("已载入：" + h.name);
}
function normalize(d) {
  d = d || blankDocument();
  d.leaves ||= []; d.pairs ||= []; d.quires ||= []; d.notes ||= ""; d.title ||= "未命名卷子";
  d.leaves.forEach((l) => { l.faces ||= { recto: "", verso: "" }; l.evidence ||= { fold: "none", seam: false, holes: 0 }; l.status ||= "doubt"; });
  d.pairs.forEach((p) => { p.evidence ||= { join: false, threadMatch: false }; p.status ||= "doubt"; });
  d.quires.forEach((q) => { q.locked ||= false; q.leaves ||= []; });
  return d;
}
$("#hypoSelect").onchange = (e) => { if (e.target.value) loadHypo(e.target.value); };

async function saveCurrent(asNew) {
  const name = $("#hypoName").value.trim() || "未命名假设";
  try {
    if (asNew || !state.meta) {
      const id = uid("h");
      const h = await api.create(id, name, state.doc);
      state.meta = { id, name, updated_at: h.updated_at };
      toast("已另存为新假设：" + name);
    } else {
      const h = await api.update(state.meta.id, name, state.doc);
      state.meta.name = name; state.meta.updated_at = h.updated_at;
      toast("已保存：" + name);
    }
    state.dirty = false;
    $("#dirtyLine").classList.add("hidden");
    await refreshHypos();
    renderHypoUI();
  } catch (err) { toast("保存失败：" + err.message, 3500); }
}
$("#btnSave").onclick = () => saveCurrent(false);
$("#btnNew").onclick = () => saveCurrent(true);

/* 假设管理列表 */
function renderHyposList() {
  const box = $("#hyposList");
  if (!state.hypos.length) { box.innerHTML = '<p class="muted">尚无已保存假设。</p>'; return; }
  box.innerHTML = state.hypos.map((h) => `<div class="hypo-row ${state.meta?.id === h.id ? "current" : ""}"
    data-hid="${h.id}">
    <input type="checkbox" class="hpick" value="${h.id}">
    <span class="hr-name">${esc(h.name)}</span>
    <span class="hr-time">${esc((h.updated_at || "").replace("T", " "))}</span>
  </div>`).join("");
  box.querySelectorAll(".hypo-row").forEach((r) =>
    r.ondblclick = () => loadHypo(r.dataset.hid));
}
$("#btnRefreshHypos").onclick = refreshHypos;
$("#btnDeleteHypo").onclick = async () => {
  const ids = $$("#hyposList .hpick").filter((c) => c.checked).map((c) => c.value);
  if (!ids.length) return toast("请勾选要删除的假设");
  if (!confirm("确定删除 " + ids.length + " 个假设？")) return;
  for (const id of ids) await api.remove(id);
  if (ids.includes(state.meta?.id)) { state.meta = null; }
  await refreshHypos();
  toast("已删除");
};
$("#btnCompare2").onclick = () => {
  const ids = $$("#hyposList .hpick").filter((c) => c.checked).map((c) => c.value);
  if (ids.length !== 2) return toast("请勾选恰好两个假设");
  openCompare(ids[0], ids[1]);
};

/* ============================================================
   假设比较
   ============================================================ */
function orderSignature(doc) {
  return doc.quires.map((q) => ({
    name: q.name,
    seq: q.leaves.map((lid) => {
      const l = doc.leaves.find((x) => x.id === lid);
      return l ? leafLabel(l) : "?";
    }),
  }));
}
function pairSet(doc) {
  return doc.pairs.map((p) => {
    const a = doc.leaves.find((x) => x.id === p.a);
    const b = doc.leaves.find((x) => x.id === p.b);
    return [a ? leafLabel(a) : "?", b ? leafLabel(b) : "?"].sort().join(" ⌒ ");
  });
}
async function openCompare(idA, idB) {
  const [ha, hb] = await Promise.all([api.get(idA), api.get(idB)]);
  const da = normalize(ha.data), db = normalize(hb.data);
  $("#cmpA").innerHTML = state.hypos.map((h) => `<option value="${h.id}" ${h.id === idA ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  $("#cmpB").innerHTML = state.hypos.map((h) => `<option value="${h.id}" ${h.id === idB ? "selected" : ""}>${esc(h.name)}</option>`).join("");
  renderCompare(da, db, ha.name, hb.name);
  $("#compareModal").classList.remove("hidden");
}
function cmpChange() {
  const a = $("#cmpA").value, b = $("#cmpB").value;
  if (a && b && a !== b) api.get(a).then((ha) => api.get(b).then((hb) =>
    renderCompare(normalize(ha.data), normalize(hb.data), ha.name, hb.name)));
}
$("#cmpA").onchange = cmpChange;
$("#cmpB").onchange = cmpChange;

function renderCompare(da, db, na, nb) {
  const oa = orderSignature(da), ob = orderSignature(db);
  const pa = pairSet(da), pb = pairSet(db);
  const ia = validate(da), ib = validate(db);

  // 叶序对照
  let rows = "";
  const maxQ = Math.max(oa.length, ob.length);
  for (let i = 0; i < maxQ; i++) {
    const a = oa[i], b = ob[i];
    const sa = a ? a.seq.join("，") : "—", sb = b ? b.seq.join("，") : "—";
    const diff = !a || !b || sa !== sb;
    rows += `<tr><td>${i + 1}</td>
      <td class="${diff ? "diff-chg" : ""}">${a ? esc(a.name) + "<br>" + esc(sa) : "✕"}</td>
      <td class="${diff ? "diff-chg" : ""}">${b ? esc(b.name) + "<br>" + esc(sb) : "✕"}</td></tr>`;
  }
  const pairAdd = pb.filter((x) => !pa.includes(x)), pairDel = pa.filter((x) => !pb.includes(x));

  const types = [...new Set([...ia, ...ib].map((x) => x.type))];
  let conflictRows = types.map((t) => {
    const ca = ia.filter((x) => x.type === t).length, cb = ib.filter((x) => x.type === t).length;
    return `<tr><td>${ISSUE_META[t].name}</td><td ${ca > cb ? 'class="diff-add"' : ca < cb ? 'class="diff-del"' : ""}>${ca}</td>
      <td ${cb > ca ? 'class="diff-add"' : cb < ca ? 'class="diff-del"' : ""}>${cb}</td></tr>`;
  }).join("");

  const stats = (d) => `叶 ${d.leaves.length} · 双叶 ${d.pairs.length} · 帖 ${d.quires.length} ·
    存疑叶 ${d.leaves.filter((l) => l.status === "doubt").length} · 锁定帖 ${d.quires.filter((q) => q.locked).length}`;

  $("#cmpResult").innerHTML = `
    <p style="font-size:12px"><b>A：${esc(na)}</b>（${stats(da)}）<br><b>B：${esc(nb)}</b>（${stats(db)}）</p>
    <div class="cmp-section"><h3>① 叶序 / 书帖对照（黄色块 = 有差异）</h3>
      <table class="cmp-table"><tr><th>#</th><th>A：${esc(na)}</th><th>B：${esc(nb)}</th></tr>${rows}</table></div>
    <div class="cmp-section"><h3>② 配叶差异</h3>
      <div class="cmp-cols">
        <div class="cmp-col"><h4>A 有而 B 无（拆对）</h4>
          <ul>${pairDel.length ? pairDel.map((x) => `<li class="diff-del">${esc(x)}</li>`).join("") : "<li>无</li>"}</ul></div>
        <div class="cmp-col"><h4>B 有而 A 无（新配）</h4>
          <ul>${pairAdd.length ? pairAdd.map((x) => `<li class="diff-add">${esc(x)}</li>`).join("") : "<li>无</li>"}</ul></div>
      </div></div>
    <div class="cmp-section"><h3>③ 冲突数量差异</h3>
      <table class="cmp-table"><tr><th>类型</th><th>A</th><th>B</th></tr>${conflictRows}</table></div>`;
}
$("#btnCompare").onclick = async () => {
  if (state.hypos.length < 2) return toast("请先保存至少两个假设（可用「另存为」）");
  openCompare(state.hypos[0].id, state.hypos[1].id);
};
$$("[data-close]").forEach((b) => b.onclick = () => b.closest(".modal").classList.add("hidden"));
$("#compareModal").addEventListener("click", (e) => { if (e.target.id === "compareModal") e.target.classList.add("hidden"); });
$("#printModal").addEventListener("click", (e) => { if (e.target.id === "printModal") e.target.classList.add("hidden"); });

/* ============================================================
   导入 / 导出 JSON
   ============================================================ */
$("#btnExport").onclick = () => {
  const blob = new Blob([JSON.stringify({
    format: "quire-restoration/v1",
    exported_at: new Date().toISOString(),
    name: state.meta?.name || $("#hypoName").value || "复原假设",
    document: state.doc,
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.meta?.name || "quire-hypothesis") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 JSON");
};
$("#btnImport").onclick = () => $("#importFile").click();
$("#importFile").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const j = JSON.parse(reader.result);
      const doc = normalize(j.document || j.data || j);
      if (state.dirty && !confirm("导入将替换当前工作稿，未保存修改会丢失。继续？")) return;
      state.doc = doc;
      state.meta = null;
      state.selection = null;
      undoStack.length = redoStack.length = 0;
      state.dirty = true;
      $("#dirtyLine").classList.remove("hidden");
      $("#hypoName").value = j.name || "导入的假设";
      state.issues = validate(state.doc);
      renderHypoUI();
      renderAll();
      toast("已导入：" + (j.name || f.name));
    } catch { toast("JSON 解析失败", 3000); }
  };
  reader.readAsText(f);
  e.target.value = "";
};

/* ============================================================
   打印图
   ============================================================ */
$("#btnPrint").onclick = () => {
  const name = state.meta?.name || $("#hypoName").value || "复原假设";
  const issues = state.issues;
  const sheets = state.doc.quires.map((q) => {
    const rows = q.leaves.map((lid, i) => {
      const l = leafById(lid), p = pairOf(lid);
      const other = p ? leafById(p.a === lid ? p.b : p.a) : null;
      const ev = [
        l.evidence.fold !== "none" ? "折痕(" + (l.evidence.fold === "outer" ? "外" : "内") + ")" : "",
        l.evidence.seam ? "接缝" : "",
        l.evidence.holes ? l.evidence.holes + "孔" : "",
        p ? "配:" + leafLabel(other) + (p.status === "confirmed" ? "✓" : "(疑)") : "",
      ].filter(Boolean).join("；");
      const lv = leafIssueLevel(lid);
      return `<tr>
        <td>${i + 1}</td><td>${esc(layerLabel(q, lid, i))}</td>
        <td>${l.folio ? esc(l.folio) : "—"}${l.frag ? " <b>[残片]</b>" : ""}</td>
        <td>${esc(l.faces?.recto || "")}</td><td>${esc(l.faces?.verso || "")}</td>
        <td>${esc(ev)}</td>
        <td>${l.status === "confirmed" ? "确定" : '<span class="doubt-tag">存疑</span>'}</td>
        <td>${lv === "err" ? '<span class="doubt-tag">●冲突</span>' : lv === "warn" ? "△注意" : ""}</td>
      </tr>`;
    }).join("");
    const qIssues = issues.filter((x) => x.qid === q.id);
    return `<div class="print-quire">
      <h3>${esc(q.name)}${q.locked ? " 🔒" : ""}　<small style="font-weight:normal">${q.leaves.length} 叶 ·
        ${q.leaves.length % 2 ? "奇数帖（中缝单叶）" : "偶数帖（双叶嵌套）"}</small></h3>
      <div style="border:1px solid #999;overflow-x:auto;background:#fff;padding:6px">${sectionSVG(q)}</div>
      <table class="print-table">
        <tr><th>位</th><th>装订层位</th><th>叶码</th><th>正面题记</th><th>背面题记</th><th>证据 / 配叶</th><th>状态</th><th>校验</th></tr>
        ${rows}
      </table>
      ${qIssues.length ? `<p class="print-note">本帖问题：${qIssues.map((x) => esc(x.msg)).join("；")}</p>` : ""}
    </div>`;
  }).join("");

  const unplaced = state.doc.leaves.filter((l) => !quireOf(l.id));
  $("#printBody").innerHTML = `
    <div class="print-sheet">
      <h2>${esc(state.doc.title || "书帖结构复原图")}</h2>
      <div class="ps-sub">假设：${esc(name)}　｜　打印时间：${new Date().toLocaleString()}　｜　书帖 ${state.doc.quires.length} · 双叶 ${state.doc.pairs.length} · 叶件 ${state.doc.leaves.length}</div>
      <div class="print-legend">
        <span><i style="border-color:#8c4a2f"></i>双叶嵌套弧线（数字为装订层位）</span>
        <span><i style="border-color:#b58a3c"></i>线孔证据</span>
        <span><i style="border-color:#35609b"></i>接缝 / 托裱</span>
        <span><i style="border-color:#8c4a2f;border-top-style:dashed"></i>折痕 / 存疑</span>
        <span class="doubt-tag">存疑</span>
        <span class="doubt-tag">●冲突</span>
        <span>🔒 已锁定关系</span>
        <span style="margin-left:auto">共 ${issues.length} 项校验提示（其中 ${issues.filter((x) => x.sev === "err").length} 项冲突）</span>
      </div>
      ${sheets || "<p>无书帖。</p>"}
      ${unplaced.length ? `<div class="print-quire"><h3>待编区（未入帖）</h3><table class="print-table">
        <tr><th>叶码</th><th>类型</th><th>证据</th><th>状态</th></tr>
        ${unplaced.map((l) => `<tr><td>${esc(leafLabel(l))}</td><td>${l.frag ? "残片" : pairOf(l.id) ? "双叶之半叶" : "单叶"}</td>
          <td>${[l.evidence.fold !== "none" ? "折痕" : "", l.evidence.seam ? "接缝" : "", l.evidence.holes ? l.evidence.holes + "孔" : ""].filter(Boolean).join("；") || "—"}</td>
          <td>${l.status === "confirmed" ? "确定" : '<span class="doubt-tag">存疑</span>'}</td></tr>`).join("")}
      </table></div>` : ""}
      ${state.doc.notes ? `<p class="print-note">备注：${esc(state.doc.notes)}</p>` : ""}
    </div>`;
  $("#printModal").classList.remove("hidden");
};
$("#btnDoPrint").onclick = () => window.print();

/* ============================================================
   键盘
   ============================================================ */
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,textarea,select")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveCurrent(false); }
});

/* ============================================================
   示例数据
   ============================================================ */
function buildSamples() {
  // ---- 假设 A：现状（含缺叶、悬空单叶、嵌套配错与待位残片） ----
  const mk = (folio, status = "confirmed", ev = {}, frag = false) => ({
    id: uid("l"), folio, faces: { recto: "", verso: "" }, status, frag, note: "",
    evidence: { fold: ev.fold || "none", seam: !!ev.seam, holes: ev.holes || 0 },
  });
  const q1leaves = [
    mk("一", "confirmed", { fold: "outer", holes: 3 }),
    mk("二", "confirmed", { fold: "inner", holes: 3 }),
    mk("四", "doubt", { seam: true, holes: 3 }),
    mk("五", "confirmed", { fold: "inner", holes: 3 }),
    mk("六", "confirmed", { fold: "outer", holes: 3 }),
  ];
  const q2leaves = [
    mk("七", "confirmed", { fold: "outer", holes: 2 }),
    mk("八", "confirmed", { fold: "inner", holes: 2 }),
    mk("九", "doubt", { seam: true, holes: 2 }),
    mk("十", "doubt", { holes: 2 }),                 // 偶数帖末多一单叶、无接缝 → 悬空
    mk("十一", "confirmed", { fold: "inner", holes: 2 }),
    mk("十二", "confirmed", { fold: "outer", holes: 2 }),
  ];
  const q3leaves = [
    mk("十三", "doubt", { fold: "outer", holes: 4 }),
    mk("十四", "doubt", { fold: "inner", holes: 4 }),
    mk("十五", "doubt", { fold: "outer", holes: 1 }),
    mk("十六", "confirmed", { holes: 4 }), // 已确认配叶却无折痕 → 证据矛盾；线孔 4 vs 1 亦矛盾
  ];
  const fragA = mk("", "doubt", { seam: true, holes: 3 }, true);
  fragA.note = "边缘残存三孔，疑第三叶位置";

  const docA = {
    version: 1, title: "某馆藏宋刻残卷（拟）",
    leaves: [...q1leaves, ...q2leaves, ...q3leaves, fragA],
    pairs: [
      { id: uid("p"), a: q1leaves[0].id, b: q1leaves[4].id, status: "confirmed", evidence: { join: true, threadMatch: true } },
      { id: uid("p"), a: q1leaves[1].id, b: q1leaves[3].id, status: "confirmed", evidence: { join: true, threadMatch: true } },
      { id: uid("p"), a: q2leaves[0].id, b: q2leaves[5].id, status: "confirmed", evidence: { join: true, threadMatch: true } },
      { id: uid("p"), a: q2leaves[1].id, b: q2leaves[4].id, status: "confirmed", evidence: { join: false, threadMatch: true } },
      // 第三帖错误交叉配对：(十三,十五)(十四,十六) → 嵌套冲突
      { id: uid("p"), a: q3leaves[0].id, b: q3leaves[2].id, status: "doubt", evidence: { join: false, threadMatch: false } },
      { id: uid("p"), a: q3leaves[1].id, b: q3leaves[3].id, status: "confirmed", evidence: { join: false, threadMatch: false } },
    ],
    quires: [
      { id: uid("q"), name: "首帖", locked: true, leaves: q1leaves.map((l) => l.id) },
      { id: uid("q"), name: "第二帖", locked: false, leaves: q2leaves.map((l) => l.id) },
      { id: uid("q"), name: "第三帖（散叶重整）", locked: false, leaves: q3leaves.map((l) => l.id) },
    ],
    notes: "第三叶缺，仅存残片待位；第三帖原配对存疑。",
  };

  // ---- 假设 B：残片嵌入第三帖中缝，并改配为正确嵌套（其余帖保持现状） ----
  const docB = clone(docA);
  const fb = docB.leaves.find((l) => l.frag);
  const q3b = docB.quires[2];
  q3b.leaves.splice(2, 0, fb.id);                 // 五叶奇数帖，残片居中
  docB.pairs = docB.pairs.filter((p) => {
    const inQ3 = q3leaves.some((l) => l.id === p.a);
    return !inQ3;
  });
  const b13 = q3leaves[0].id, b14 = q3leaves[1].id, b15 = q3leaves[2].id, b16 = q3leaves[3].id;
  docB.pairs.push(
    { id: uid("p"), a: b13, b: b16, status: "doubt", evidence: { join: false, threadMatch: true } },
    { id: uid("p"), a: b14, b: b15, status: "doubt", evidence: { join: false, threadMatch: true } });
  docB.notes = "尝试方案：残片置于第三帖中缝，十三⌒十六、十四⌒十五 正确嵌套（证据仍不足，保持存疑）。";
  return { docA, docB };
}

/* ============================================================
   启动
   ============================================================ */
async function boot() {
  try {
    let hypos = await api.list();
    if (hypos.length === 0) {
      const { docA, docB } = buildSamples();
      const idA = uid("h"), idB = uid("h");
      await api.create(idA, "假设A：现状著录（有缺叶与冲突）", docA);
      await api.create(idB, "假设B：残片嵌入第三帖", docB);
      hypos = await api.list();
    }
    state.hypos = hypos;
    const first = hypos[0];
    const h = await api.get(first.id);
    state.doc = normalize(h.data);
    state.meta = { id: h.id, name: h.name, updated_at: h.updated_at };
    state.issues = validate(state.doc);
    renderHypoUI();
    renderHyposList();
    renderAll();
    toast("已载入示例假设。可直接编辑，或在「假设」标签中双击切换。", 3600);
  } catch (err) {
    console.error(err);
    state.doc = blankDocument();
    state.issues = [];
    renderAll();
    toast("后端连接失败：请确认通过 http://127.0.0.1:8371 访问", 4000);
  }
}
boot();

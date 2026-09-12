/* ============================================================
   书帖结构复原台 —— 前端逻辑（原生 JS + SVG，无外部依赖）
   ============================================================ */
"use strict";

/* ---------------- 小工具 ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
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
  chainAnalysis: null,   // 证据链分析缓存
  chainEditing: null,    // 右栏正在编辑的证据 id
  graphScope: null,      // 关系图范围：null=全部，{kind:'leaf'|'pair'|'quire', id}
  graphExpand: false,    // 是否展开推导依据
  graphMerge: false,     // 合并重复模式
  graphMergeFirst: null, // 合并模式下选中的第一条证据
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
function syncUndoButtons() {
  $("#btnUndo").disabled = undoStack.length === 0;
  $("#btnRedo").disabled = redoStack.length === 0;
}

/* ---------------- 文档结构 ---------------- */
function blankDocument(title) {
  return { version: 1, title: title || "未命名卷子", leaves: [], pairs: [], quires: [],
    evidences: [], claims: [], links: [], notes: "" };
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
  syncUndoButtons();
}
function afterStructural(msg) {
  state.issues = validate(state.doc);
  recomputeChain();
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
  /* 重号按“数值等值”归组：阿拉伯数字与中文数字同值视为同一叶码
     （「一」与「1」为重号）；无法解析出数值的叶码（空码、纯卷次标注等）不参与重号比对 */
  const numGroups = new Map(); // num -> [{g}]
  global.forEach((g) => {
    if (g.num == null) return;
    if (!numGroups.has(g.num)) numGroups.set(g.num, []);
    numGroups.get(g.num).push(g);
  });
  for (const [, gs] of numGroups) {
    if (gs.length < 2) continue;
    const rawForms = [...new Set(gs.map((g) => "「" + g.raw + "」"))];
    gs.forEach((g) =>
      add("dup", "重号：叶码 " + rawForms.join("、") + " 数值相同（= 第 " + numToDisplay(g.num) +
        " 叶），共 " + gs.length + " 处", g.q.name + " · 第" + (g.pos + 1) + "位",
        { qid: g.q.id, lid: g.lid }));
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
   证据链模块：独立装订证据记录、版本、结论关系与冲突识别
   ------------------------------------------------------------
   doc.evidences[]  证据记录（独立于叶片/双叶对象，删除对象不改动记录，仅标悬空）
   doc.claims[]     用户提出的候选结论（配叶/层位/叶序/其他）
   doc.links[]      证据 — 结论 关系（support 支持 / refute 反驳）
   系统结论（当前结构中的配叶/层位/叶序）以合成 ID 虚拟生成，不写入文档。
   冲突只标记、不改结构。
   ============================================================ */
const EV_TYPES = {
  holes: { name: "线孔", icon: "孔" },
  fold: { name: "折痕", icon: "折" },
  seam: { name: "接缝", icon: "缝" },
  folio: { name: "叶码连续", icon: "码" },
  paper: { name: "纸张特征", icon: "纸" },
  other: { name: "其他", icon: "他" },
};
const CRED_LABEL = { high: "高可信", medium: "中可信", low: "低可信" };
const EV_STATUS = { pending: "待核验", confirmed: "已确认" };
const STANCE_LABEL = { support: "支持", refute: "反驳" };
const CLAIM_KIND_LABEL = { pair: "配叶", place: "层位", order: "叶序", note: "其他结论" };

function chainInit(doc) {
  doc.evidences ||= []; doc.claims ||= []; doc.links ||= [];
}
function normalizeChain(doc) {
  chainInit(doc);
  doc.evidences.forEach((ev) => {
    ev.subjects ||= [];
    ev.kind ||= "other";
    ev.status ||= "pending";
    ev.credibility ||= "medium";
    ev.source ||= "";
    ev.detail ||= "";
    ev.basis ||= [];
    ev.archived ||= false;
    ev.mergedInto ||= null;
    ev.history ||= [];
    ev.created_at ||= new Date().toISOString();
  });
  doc.claims.forEach((c) => {
    c.kind ||= "note"; c.label ||= ""; c.note ||= "";
    c.created_at ||= new Date().toISOString();
  });
  doc.links.forEach((lk) => {
    lk.stance ||= "support";
    lk.created_at ||= new Date().toISOString();
  });
  return doc;
}
function activeEvidences(doc) { return (doc.evidences || []).filter((e) => !e.archived); }
function evidenceById(id, doc = state.doc) { return (doc.evidences || []).find((e) => e.id === id); }
function chainTargetLabel(doc, id) {
  if (!id) return "？";
  if (id.startsWith("ev:")) {
    const ev = (doc.evidences || []).find((e) => e.id === id);
    return ev ? ev.title : "已删除证据";
  }
  const cl = claimById(doc, id);
  return cl ? cl.label : (id.startsWith("c:") || id.startsWith("~") ? "已删除结论" : id);
}
function claimById(doc, id) {
  return (doc.claims || []).find((c) => c.id === id);
}

/* ---------- 证据版本：关键字段修订留痕 ---------- */
function pushHistory(ev, note) {
  ev.history = ev.history || [];
  ev.history.push({
    at: new Date().toISOString(),
    note: note || "",
    title: ev.title, kind: ev.kind,
    subjects: clone(ev.subjects), detail: ev.detail,
    source: ev.source, credibility: ev.credibility, status: ev.status,
  });
}

/* ---------- 系统结论注册表 ---------- */
function buildClaims(doc) {
  const byId = new Map();
  const add = (id, kind, label, refs, extra = {}) => {
    const cl = { id, kind, label, refs, system: true, current: true, ...extra };
    byId.set(id, cl);
    return cl;
  };
  // 配叶：当前文档中的双叶
  doc.pairs.forEach((p) => {
    const la = (doc.leaves || []).find((l) => l.id === p.a);
    const lb = (doc.leaves || []).find((l) => l.id === p.b);
    add("~pair:" + p.id, "pair",
      "配叶：" + (la ? leafLabel(la) : "缺叶") + " ⌒ " + (lb ? leafLabel(lb) : "缺叶"),
      ["pair", p.a, p.b], { pairId: p.id, pairStatus: p.status, exists: !!(la && lb) });
  });
  // 层位：每帖每个已入帖叶件
  doc.quires.forEach((q) => {
    const n = q.leaves.length;
    q.leaves.forEach((lid, i) => {
      const l = (doc.leaves || []).find((x) => x.id === lid);
      let layer;
      if (n % 2 && i === (n - 1) / 2) layer = "中缝单叶";
      else layer = "第 " + (Math.min(i, n - 1 - i) + 1) + " 层";
      add("~place:" + q.id + ":" + lid, "place",
        "层位：" + (l ? leafLabel(l) : "缺叶") + " 位于「" + q.name + "」" + layer +
          "（第 " + (i + 1) + " 位）",
        ["leaf", lid, q.id], { qid: q.id, leaf: lid, exists: !!l });
    });
  });
  // 叶序：帖内与跨帖的相邻关系
  const flat = [];
  doc.quires.forEach((q) => q.leaves.forEach((lid) => flat.push({ lid, q })));
  for (let i = 1; i < flat.length; i++) {
    const aId = flat[i - 1].lid, bId = flat[i].lid;
    const aq = flat[i - 1].q;
    const la = (doc.leaves || []).find((l) => l.id === aId);
    const lb = (doc.leaves || []).find((l) => l.id === bId);
    const cross = aq !== flat[i].q;
    add("~order:" + aId + ":" + bId, "order",
      "叶序：" + (la ? leafLabel(la) : "缺叶") + " → " + (lb ? leafLabel(lb) : "缺叶") +
        (cross ? "（跨帖：" + aq.name + " → " + flat[i].q.name + "）" : "（帖内相邻）"),
      ["order", aId, bId], { exists: !!(la && lb) });
  }
  // 用户候选结论
  (doc.claims || []).forEach((c) => {
    const decorated = decorateUserClaim(doc, { ...c, system: false });
    byId.set(c.id, decorated);
  });
  return byId;
}
function decorateUserClaim(doc, c) {
  c.refs = [];
  c.exists = true;
  if (c.kind === "pair") {
    const la = (doc.leaves || []).find((l) => l.id === c.a);
    const lb = (doc.leaves || []).find((l) => l.id === c.b);
    c.label = "候选配叶：" + (la ? leafLabel(la) : "缺叶/" + sid(c.a)) + " ⌒ " + (lb ? leafLabel(lb) : "缺叶/" + sid(c.b));
    c.refs = ["pair", c.a, c.b];
    c.exists = !!(la && lb);
  } else if (c.kind === "place") {
    const l = (doc.leaves || []).find((x) => x.id === c.leaf);
    const q = (doc.quires || []).find((x) => x.id === c.qid);
    c.label = "候选层位：" + (l ? leafLabel(l) : "缺叶/" + sid(c.leaf)) + " 置入「" + (q ? q.name : "已删帖") + "」第 " + (c.pos + 1) + " 位";
    c.refs = ["leaf", c.leaf, c.qid];
    c.exists = !!(l && q);
  } else if (c.kind === "order") {
    const la = (doc.leaves || []).find((l) => l.id === c.a);
    const lb = (doc.leaves || []).find((l) => l.id === c.b);
    c.label = "候选叶序：" + (la ? leafLabel(la) : "缺叶/" + sid(c.a)) + " → " + (lb ? leafLabel(lb) : "缺叶/" + sid(c.b));
    c.refs = ["order", c.a, c.b];
    c.exists = !!(la && lb);
  } else {
    c.label = c.text || "其他结论";
  }
  return c;
}

/* ---------- 互斥键 ---------- */
function exclusiveKey(cl) {
  let a = null, b = null;
  if (cl.kind === "pair") {
    if (cl.system) { a = cl.refs[1]; b = cl.refs[2]; }
    else { a = cl.a; b = cl.b; }
    return a && b ? ["pair:" + a, "pair:" + b] : [];
  }
  if (cl.kind === "place") {
    a = cl.system ? cl.refs[1] : cl.leaf;
    return a ? ["place:" + a] : [];
  }
  if (cl.kind === "order") {
    if (cl.system) { a = cl.refs[1]; b = cl.refs[2]; }
    else { a = cl.a; b = cl.b; }
    const pair = [a, b].filter(Boolean).sort().join("|");
    return pair ? ["order:" + pair] : [];
  }
  return [];
}

/* ---------- 证据链分析：冲突、悬空、循环（只标记，不改结构） ---------- */
function chainAnalysis(doc) {
  chainInit(doc);
  const claimsById = buildClaims(doc);
  const flags = { link: new Map(), ev: new Map() };
  const issues = [];
  const flagLink = (lk, kind, msg) => {
    if (!flags.link.has(lk.id)) flags.link.set(lk.id, []);
    flags.link.get(lk.id).push({ kind, msg });
  };
  const flagEv = (id, kind, msg) => {
    if (!id) { issues.push({ kind, msg, target: null }); return; }
    if (!flags.ev.has(id)) flags.ev.set(id, []);
    flags.ev.get(id).push({ kind, msg });
  };

  const validEvs = new Set(activeEvidences(doc).map((e) => e.id));

  for (const lk of doc.links) {
    const ev = evidenceById(lk.evidence, doc);
    const cl = claimsById.get(lk.target);
    if (!ev || ev.archived) {
      flagLink(lk, "dangling-ev", "关系引用的证据记录已删除/已合并");
      continue;
    }
    if (!cl) {
      flagLink(lk, "dangling-target", "证据「" + ev.title + "」引用了已删除的结论对象");
      flagEv(ev.id, "dangling-target", "引用了已删除的结论对象（关系仅标记，不改动）");
      continue;
    }
    if (cl.exists === false) {
      flagLink(lk, "dangling-target", (cl.system ? "结论涉及的叶件已删除：" : "候选结论涉及的叶件已删除：") + cl.label);
      flagEv(ev.id, "dangling-target", (cl.system ? "结论涉及已删除叶件：" : "候选结论涉及已删除叶件：") + cl.label);
    }
  }

  // 互斥结论被同一证据（含其合并前记录）支持。
  // 同一证据反驳多条互斥结论是自然推理，不计冲突。
  const groups = new Map(); // exKey -> [{cl, lk}]
  const evAliases = (id) => {
    const set = new Set([id]);
    for (const e of doc.evidences) if (e.mergedInto === id) set.add(e.id);
    return set;
  };
  for (const lk of doc.links) {
    if (lk.stance !== "support") continue;
    if (flags.link.get(lk.id)?.some((f) => f.kind === "dangling-ev")) continue;
    const cl = claimsById.get(lk.target);
    if (!cl) continue;
    for (const key of exclusiveKey(cl)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ cl, lk });
    }
  }
  const claimConflict = new Map(); // claimId -> [{withId, msg}]
  for (const [, arr] of groups) {
    const distinct = [...new Set(arr.map((x) => x.cl.id))];
    if (distinct.length < 2) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const A = arr[i], B = arr[j];
        if (A.cl.id === B.cl.id) continue;
        const ali = evAliases(A.lk.evidence), blj = evAliases(B.lk.evidence);
        const overlap = [...ali].some((x) => blj.has(x));
        if (!overlap) continue;
        const msg = "同一证据同时支持互斥结论：" + A.cl.label + " ⇎ " + B.cl.label;
        flagLink(A.lk, "mutex", msg); flagLink(B.lk, "mutex", msg);
        flagEv(A.lk.evidence, "mutex", msg);
        if (!claimConflict.has(A.cl.id)) claimConflict.set(A.cl.id, []);
        claimConflict.get(A.cl.id).push({ withId: B.cl.id, msg });
      }
    }
  }

  // 推导依据图：证据 -> 证据。自我证明（直接自引）与循环依赖（SCC）
  const basisEdges = [];
  for (const ev of activeEvidences(doc)) {
    for (const b of ev.basis || []) {
      if (b === ev.id) {
        flagEv(ev.id, "self", "自我证明：证据把自身列为推导依据");
        continue;
      }
      const target = evidenceById(b, doc);
      if (!target || target.archived) {
        flagEv(ev.id, "dangling-basis", "推导依据引用了已删除/已合并的证据记录");
        continue;
      }
      basisEdges.push([ev.id, b]);
    }
  }
  const cycles = tarjanCycles(validEvs, basisEdges);
  for (const cyc of cycles) {
    const labels = cyc.map((id) => "「" + (evidenceById(id, doc)?.title || id) + "」").join(" → ");
    for (const id of cyc) flagEv(id, "cycle", "循环依赖：" + labels + " → 回到起点");
  }

  return { claimsById, flags, issues, cycles, claimConflict };
}

/* Tarjan SCC：返回大小≥2 的环，或含自环的单点（自环已在上面单列） */
function tarjanCycles(nodes, edges) {
  const adj = new Map();
  nodes.forEach((n) => adj.set(n, []));
  for (const [a, b] of edges) if (adj.has(a) && adj.has(b)) adj.get(a).push(b);
  let idx = 0;
  const index = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v)) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length >= 2) out.push(comp);
    }
  };
  nodes.forEach((n) => { if (!index.has(n)) strong(n); });
  return out;
}

/* 当前假设下展开：从结论出发，列直接证据与逐级推导依据（检测环） */
function expandClaim(doc, analysis, claimId, maxDepth = 6) {
  const result = [];
  const seen = new Set();
  const walk = (evId, depth, viaLink, trail) => {
    if (depth > maxDepth || seen.has(evId)) return;
    seen.add(evId);
    const ev = evidenceById(evId, doc);
    if (!ev) return;
    result.push({ ev, depth, viaLink, trail });
    for (const b of ev.basis || []) {
      if (trail.includes(b) || b === evId) continue;
      walk(b, depth + 1, null, [...trail, b]);
    }
  };
  for (const lk of doc.links) {
    if (lk.target === claimId) walk(lk.evidence, 0, lk, [lk.evidence]);
  }
  return result;
}

/* ---------- 证据记录操作（均入撤销栈） ---------- */
function makeEvidence(prefill = {}) {
  return {
    id: uid("e"),
    title: prefill.title || "未命名证据",
    kind: prefill.kind || "other",
    subjects: prefill.subjects || [],
    detail: "", source: "",
    credibility: "medium", status: "pending",
    basis: [], archived: false, mergedInto: null,
    history: [], created_at: new Date().toISOString(),
  };
}
function addEvidence(prefill) {
  const ev = makeEvidence(prefill);
  commit("新增证据记录", () => { state.doc.evidences.push(ev); state.chainEditing = ev.id; });
  return ev.id;
}
function updateEvidence(id, patch, historyNote) {
  const ev = evidenceById(id);
  if (!ev) return;
  pushUndo("编辑证据：" + ev.title);
  if (historyNote) pushHistory(ev, historyNote);
  Object.assign(ev, patch);
  afterStructural("");
}
function deleteEvidence(id) {
  const ev = evidenceById(id);
  if (!ev) return;
  const rel = state.doc.links.filter((l) => l.evidence === id).length;
  if (!confirm("删除证据「" + ev.title + "」？" + (rel ? "（其 " + rel + " 条结论关系会一并删除）" : ""))) return;
  commit("删除证据：" + ev.title, () => {
    state.doc.evidences = state.doc.evidences.filter((e) => e.id !== id);
    state.doc.links = state.doc.links.filter((l) => l.evidence !== id);
    state.doc.evidences.forEach((e) => { e.basis = (e.basis || []).filter((b) => b !== id); });
    if (state.chainEditing === id) state.chainEditing = null;
  });
}

/* 确认证据前：预览受影响结论与新增冲突 */
function previewConfirmEvidence(id) {
  const ev = evidenceById(id);
  if (!ev || ev.status === "confirmed") return;
  const targets = state.doc.links.filter((l) => l.evidence === id).map((l) => state.chainAnalysis.claimsById.get(l.target)).filter(Boolean);
  const trial = clone(state.doc);
  const tev = trial.evidences.find((e) => e.id === id);
  tev.status = "confirmed";
  const ta = chainAnalysis(trial);
  const conflictNow = new Set((state.chainAnalysis.flags.ev.get(id) || []).map((f) => f.kind + f.msg));
  const newConflicts = (ta.flags.ev.get(id) || []).filter((f) => !conflictNow.has(f.kind + f.msg));
  openMini({
    title: "确认前预览：" + ev.title,
    body: `
      <p class="muted">该证据目前被 ${targets.length} 条结论关系引用，确认后将随导出/打印标注为「已确认」。</p>
      <div class="mini-sub">受影响结论（${targets.length}）</div>
      <ul class="mini-list">${targets.length ? targets.map((c) => `<li><span class="mini-k ${c.kind}">${CLAIM_KIND_LABEL[c.kind]}</span>${esc(c.label)}</li>`).join("") : "<li>（暂未关联任何结论）</li>"}</ul>
      ${newConflicts.length ? `<div class="mini-sub err">确认后仍存在的冲突标记（只标记，不改动结构）</div>
        <ul class="mini-list">${newConflicts.map((f) => `<li class="err">${esc(f.msg)}</li>`).join("")}</ul>` : ""}`,
    actions: [
      { label: "取消", ghost: true },
      { label: "仍要标记为已确认", primary: true, fn: () => updateEvidence(id, { status: "confirmed" }, "由待核验改为已确认") },
    ],
  });
}

/* 合并重复记录：关系迁移、依据改指，被并记录归档（保留版本可溯） */
function mergeEvidence(keepId, absorbId) {
  const keep = evidenceById(keepId), absorb = evidenceById(absorbId);
  if (!keep || !absorb || keepId === absorbId) return;
  commit("合并证据：" + absorb.title + " → " + keep.title, () => {
    pushHistory(keep, "合并入重复记录「" + absorb.title + "」(" + absorb.id + ")");
    absorb.archived = true;
    absorb.mergedInto = keepId;
    for (const lk of state.doc.links.filter((l) => l.evidence === absorbId)) {
      if (state.doc.links.some((x) => x.evidence === keepId && x.target === lk.target && x.stance === lk.stance)) continue;
      state.doc.links.push({ ...lk, evidence: keepId, created_at: new Date().toISOString() });
    }
    state.doc.links = state.doc.links.filter((l) => l.evidence !== absorbId);
    for (const e of state.doc.evidences) {
      e.basis = (e.basis || []).map((b) => (b === absorbId ? keepId : b));
      e.basis = [...new Set(e.basis.filter((b) => !(b === keepId && e.id === keepId)))];
    }
    const subj = new Set([...(keep.subjects || []), ...(absorb.subjects || [])]);
    keep.subjects = [...subj];
    state.chainEditing = keepId;
  });
}

/* ---------- 关系与候选结论操作 ---------- */
function addLink(evidenceId, targetId, stance = "support") {
  if (!evidenceId || !targetId) return;
  if (state.doc.links.some((l) => l.evidence === evidenceId && l.target === targetId && l.stance === stance)) {
    toast("该关系已存在"); return;
  }
  commit((stance === "support" ? "建立支持关系" : "建立反驳关系"), () => {
    state.doc.links.push({ id: uid("lk"), evidence: evidenceId, target: targetId, stance,
      created_at: new Date().toISOString() });
  });
  const newFlags = state.chainAnalysis.flags.link;
  const lk = state.doc.links[state.doc.links.length - 1];
  const fl = newFlags.get(lk.id);
  if (fl?.length) toast("已建立，但存在冲突标记：" + fl[0].msg, 3400);
}
function deleteLink(id) {
  const lk = state.doc.links.find((x) => x.id === id);
  if (!lk) return;
  commit("删除证据—结论关系", () => {
    state.doc.links = state.doc.links.filter((x) => x.id !== id);
  });
}
function addUserClaim(claim) {
  const c = { id: uid("c"), created_at: new Date().toISOString(), ...claim };
  commit("新增候选结论", () => { state.doc.claims.push(c); });
  return c.id;
}
function deleteUserClaim(id) {
  const c = claimById(state.doc, id);
  if (!c) return;
  const rel = state.doc.links.filter((l) => l.target === id).length;
  if (!confirm("删除候选结论「" + c.label + "」？" + (rel ? "（" + rel + " 条证据关系一并删除）" : ""))) return;
  commit("删除候选结论", () => {
    state.doc.claims = state.doc.claims.filter((x) => x.id !== id);
    state.doc.links = state.doc.links.filter((l) => l.target !== id);
  });
}

/* 分析结果缓存：随结构更新 */
function recomputeChain() {
  state.chainAnalysis = chainAnalysis(state.doc);
}

/* ============================================================
   证据链：右栏标签页（记录列表 + 编辑表单）
   ============================================================ */
function subjectChips(doc, subjects, opts = {}) {
  return (subjects || []).map((sid0) => {
    let el = null, label = "";
    if (sid0.startsWith("l:")) {
      const l = (doc.leaves || []).find((x) => x.id === sid0.slice(2));
      label = l ? leafLabel(l) : "已删叶";
      el = l ? { kind: "leaf", id: l.id } : null;
    } else if (sid0.startsWith("p:")) {
      const p = (doc.pairs || []).find((x) => x.id === sid0.slice(2));
      const la = p ? (doc.leaves || []).find((l) => l.id === p.a) : null;
      const lb = p ? (doc.leaves || []).find((l) => l.id === p.b) : null;
      label = p ? "双叶 " + (la ? leafLabel(la) : "?") + "⌒" + (lb ? leafLabel(lb) : "?") : "已删双叶";
      el = p ? { kind: "pair", id: p.id } : null;
    } else if (sid0.startsWith("q:")) {
      const q = (doc.quires || []).find((x) => x.id === sid0.slice(2));
      label = q ? "帖「" + q.name + "」" : "已删帖";
      el = q ? { kind: "quire", id: q.id } : null;
    }
    if (!el) return `<span class="subj-chip dangling" title="引用对象已删除">⛓ ${esc(label)}</span>`;
    return `<a class="subj-chip ${el.kind}" href="#" data-focus='${JSON.stringify(el)}'
      title="反向定位到画布对象">⛟ ${esc(label)}</a>`;
  }).join(" ");
}

function chainFlagSummary(evId) {
  const fl = state.chainAnalysis.flags.ev.get(evId) || [];
  if (!fl.length) return "";
  const kinds = [...new Set(fl.map((f) => f.kind))];
  const name = { mutex: "互斥冲突", "dangling-target": "引用已删除", "dangling-basis": "依据缺失",
    self: "自我证明", cycle: "循环依赖" };
  return `<span class="chain-bad err" title="${esc(fl.map((f) => f.msg).join("\n"))}">
    ${kinds.map((k) => name[k] || k).join("、")}</span>`;
}

function renderChainTab() {
  const badge = $("#chainCount");
  if (badge) badge.textContent = activeEvidences(state.doc).length;
  if ($("#tab-chain").classList.contains("active") === false && !state.chainEditing) {
    // 即使标签页隐藏也维护内容，但编辑器展开状态由数据驱动
  }
  // 冲突摘要框（跨证据 + 悬空关系）
  const cf = $("#chainConflictBox");
  if (cf) {
    const rows = [];
    state.chainAnalysis.flags.ev.forEach((fl, id) => {
      const ev = evidenceById(id);
      fl.forEach((f) => rows.push({ id, title: ev?.title || id, ...f }));
    });
    state.chainAnalysis.flags.link.forEach((fl) => {
      fl.filter((f) => f.kind === "dangling-ev" || f.kind === "dangling-target").forEach((f) =>
        rows.push({ id: null, title: "结论关系", ...f }));
    });
    if (!rows.length) {
      cf.innerHTML = '<div class="chain-ok">✓ 证据链未见互斥、悬空或循环冲突</div>';
    } else {
      cf.innerHTML = `<div class="chain-conflict-head">${rows.length} 项冲突标记（只标记，不改动结构）</div>` +
        rows.slice(0, 6).map((r) => `<div class="chain-conflict-row" ${r.id ? `data-edit-ev="${r.id}"` : ""}
          title="${esc(r.msg)}"><span class="cc-dot"></span>${esc(r.msg)}</div>`).join("") +
        (rows.length > 6 ? `<div class="muted" style="padding:2px 4px">其余 ${rows.length - 6} 项见关系图…</div>` : "");
      cf.querySelectorAll("[data-edit-ev]").forEach((d) =>
        d.onclick = () => { state.chainEditing = d.dataset.editEv; renderChainTab(); });
    }
  }

  if (state.chainEditing) { renderChainEditor(); return; }

  const box = $("#chainList");
  if (!box) return;
  const evs = activeEvidences(state.doc);
  if (!evs.length) {
    box.innerHTML = '<p class="muted">尚无独立证据记录。点「＋ 新证据」装订建档；或在叶件/双叶详情中点「关系图」。</p>';
    return;
  }
  // 归档记录（被合并）折叠显示
  const archived = state.doc.evidences.filter((e) => e.archived);
  box.innerHTML = evs.map((ev) => {
    const linkCount = state.doc.links.filter((l) => l.evidence === ev.id).length;
    const sup = state.doc.links.filter((l) => l.evidence === ev.id && l.stance === "support").length;
    const ref = linkCount - sup;
    return `<div class="chain-row" data-edit-ev="${ev.id}">
      <span class="cr-kind k-${ev.kind}" title="${EV_TYPES[ev.kind]?.name || "其他"}">${EV_TYPES[ev.kind]?.icon || "他"}</span>
      <div class="cr-main">
        <div class="cr-title">${esc(ev.title)} ${chainFlagSummary(ev.id)}</div>
        <div class="cr-meta">
          <span class="cr-cred c-${ev.credibility}">${CRED_LABEL[ev.credibility] || ev.credibility}</span>
          <span class="${ev.status === "confirmed" ? "cr-confirmed" : "cr-pending"}">${EV_STATUS[ev.status]}</span>
          <span title="版本数">v${(ev.history?.length || 0) + 1}</span>
          ${sup ? `<span class="cr-sup">支 ${sup}</span>` : ""}
          ${ref ? `<span class="cr-ref">驳 ${ref}</span>` : ""}
          <span class="cr-arch" style="display:none"></span>
        </div>
        <div class="cr-subj">${subjectChips(state.doc, ev.subjects)}</div>
      </div>
    </div>`;
  }).join("") + (archived.length ? `<details class="archived-box"><summary>已合并归档记录（${archived.length}）</summary>
    ${archived.map((ev) => `<div class="chain-row archived">
      <span class="cr-kind k-${ev.kind}">${EV_TYPES[ev.kind]?.icon || "他"}</span>
      <div class="cr-main"><div class="cr-title">${esc(ev.title)}</div>
      <div class="cr-meta"><span>已并入：${esc(evidenceById(ev.mergedInto)?.title || "?")}</span></div></div>
    </div>`).join("")}</details>` : "");
  box.querySelectorAll("[data-edit-ev]").forEach((r) =>
    r.onclick = (e) => {
      if (e.target.closest("[data-focus]")) return;
      state.chainEditing = r.dataset.editEv; renderChainTab();
    });
  bindFocusChips(box);
}

function renderChainEditor() {
  const box = $("#chainList");
  const ed = $("#chainEditor");
  if (!box || !ed) return;
  box.classList.add("hidden");
  ed.classList.remove("hidden");
  const ev = evidenceById(state.chainEditing);
  if (!ev) { state.chainEditing = null; box.classList.remove("hidden"); ed.classList.add("hidden"); renderChainTab(); return; }
  const an = state.chainAnalysis;
  const links = state.doc.links.filter((l) => l.evidence === ev.id);
  const basisOptions = activeEvidences(state.doc).filter((e) => e.id !== ev.id);

  ed.innerHTML = `
    <div class="chain-editor-head">
      <button class="btn small ghost light" id="evBack">← 返回列表</button>
      <span class="${ev.status === "confirmed" ? "cr-confirmed" : "cr-pending"}">${EV_STATUS[ev.status]}</span>
      <span class="cr-cred c-${ev.credibility}">${CRED_LABEL[ev.credibility]}</span>
      ${chainFlagSummary(ev.id)}
    </div>
    <div class="field"><label>标题</label><input type="text" id="evTitle" value="${esc(ev.title)}"></div>
    <div class="field"><label>类型</label><select id="evKind">
      ${Object.entries(EV_TYPES).map(([k, v]) => `<option value="${k}" ${ev.kind === k ? "selected" : ""}>${v.name}</option>`).join("")}
    </select></div>
    <div class="field"><label>可信度</label><select id="evCred">
      ${["high", "medium", "low"].map((k) => `<option value="${k}" ${ev.credibility === k ? "selected" : ""}>${CRED_LABEL[k]}</option>`).join("")}
    </select>
    <select id="evStatus" style="max-width:96px">
      <option value="pending" ${ev.status === "pending" ? "selected" : ""}>待核验</option>
      <option value="confirmed" ${ev.status === "confirmed" ? "selected" : ""}>已确认</option>
    </select></div>
    <div class="field"><label>来源说明</label><input type="text" id="evSource" value="${esc(ev.source || "")}"
      placeholder="如：目验 2026-09-10 / 某馆修复档案 3:12"></div>
    <div class="field" style="align-items:flex-start"><label>观测描述</label><textarea id="evDetail">${esc(ev.detail || "")}</textarea></div>

    <div class="chain-subj-head">关联对象
      <button class="btn small ghost light" id="btnAddSubject">＋</button></div>
    <div class="chain-subj-list">${subjectChips(state.doc, ev.subjects) || '<span class="muted">可关联叶片 / 双叶 / 书帖（线孔、折痕、接缝、叶码连续、纸张特征等）</span>'}</div>

    <div class="chain-subj-head">推导依据（其他证据）</div>
    <div class="chain-basis-list">
      ${(ev.basis || []).map((b) => {
        const be = evidenceById(b);
        return `<div class="basis-row ${be ? "" : "dangling"}">
          <a href="#" data-edit-basis="${b}">⛓ ${esc(be ? be.title : "已删除证据")}</a>
          <button data-rm-basis="${b}" title="移除依据">×</button></div>`;
      }).join("") || '<span class="muted">直接证据无依据；选择其他证据表示本记录是推导结论。</span>'}
      <select id="basisSel"><option value="">— 添加推导依据 —</option>
        ${basisOptions.filter((e) => !(ev.basis || []).includes(e.id)).map((e) =>
          `<option value="${e.id}">${esc(e.title)}</option>`).join("")}
      </select>
    </div>

    <div class="chain-subj-head">支持 / 反驳的结论（${links.length}）
      <button class="btn small ghost light" id="btnGraphFromEv">在关系图中连接…</button></div>
    <div class="chain-links-list">
      ${links.length ? links.map((lk) => {
        const cl = an.claimsById.get(lk.target);
        const fl = an.flags.link.get(lk.id) || [];
        return `<div class="clink-row ${lk.stance}">
          <span class="clink-stance">${lk.stance === "support" ? "▲ 支持" : "▼ 反驳"}</span>
          ${cl ? `<a href="#" data-focus-claim="${cl.id}">${esc(cl.label)}</a>`
            : `<span class="dangling-text">${esc(chainTargetLabel(state.doc, lk.target))}（已删除）</span>`}
          <button data-rm-link="${lk.id}" title="删除关系">×</button>
          ${fl.length ? `<div class="clink-flags" title="${esc(fl.map((f) => f.msg).join("\n"))}">
            ${[...new Set(fl.map((f) => ({ mutex: "互斥", "dangling-ev": "悬空", "dangling-target": "悬空" }[f.kind])))].join("、")}</div>` : ""}
        </div>`;
      }).join("") : '<span class="muted">无。在关系图中从证据节点拖线到结论节点建立。</span>'}
    </div>

    ${ev.history?.length ? `<details class="chain-history"><summary>版本历史（${ev.history.length} 条修订）</summary>
      ${ev.history.slice().reverse().map((h, i) => `<div class="hist-row">
        <b>v${ev.history.length - i}</b> <span class="muted">${esc((h.at || "").replace("T", " ").slice(0, 16))}</span>
        ${h.note ? `<div>${esc(h.note)}</div>` : ""}
        <div class="muted">${esc(h.title)} · ${EV_TYPES[h.kind]?.name || h.kind} · ${CRED_LABEL[h.credibility]} · ${EV_STATUS[h.status]}</div>
      </div>`).join("")}</details>` : ""}

    <div class="chain-editor-actions">
      <button class="btn small" id="btnOpenGraph">打开关系图</button>
      <button class="btn small danger" id="btnDelEv" style="margin-left:auto">删除记录</button>
    </div>`;

  $("#evBack").onclick = () => { state.chainEditing = null; $("#chainList").classList.remove("hidden"); $("#chainEditor").classList.add("hidden"); renderChainTab(); };
  $("#evTitle").onchange = (e) => updateEvidence(ev.id, { title: e.target.value.trim() || ev.title }, "修改标题");
  $("#evKind").onchange = (e) => updateEvidence(ev.id, { kind: e.target.value }, "修改证据类型");
  $("#evCred").onchange = (e) => updateEvidence(ev.id, { credibility: e.target.value }, "可信度调整为 " + CRED_LABEL[e.target.value]);
  $("#evStatus").onchange = (e) => {
    if (e.target.value === "confirmed") { e.target.value = ev.status; previewConfirmEvidence(ev.id); return; }
    updateEvidence(ev.id, { status: "pending" }, "由已确认改回待核验");
  };
  $("#evSource").onchange = (e) => updateEvidence(ev.id, { source: e.target.value }, "更新来源说明");
  $("#evDetail").onchange = (e) => updateEvidence(ev.id, { detail: e.target.value }, "更新观测描述");
  $("#btnAddSubject").onclick = () => pickSubject(ev);
  $("#basisSel").onchange = (e) => {
    const b = e.target.value;
    if (!b) return;
    updateEvidence(ev.id, { basis: [...new Set([...(ev.basis || []), b])] }, "添加推导依据");
  };
  ed.querySelectorAll("[data-rm-basis]").forEach((b) =>
    b.onclick = () => updateEvidence(ev.id, { basis: (ev.basis || []).filter((x) => x !== b.dataset.rmBasis) }, "移除推导依据"));
  ed.querySelectorAll("[data-edit-basis]").forEach((a) =>
    a.onclick = (e) => { e.preventDefault(); state.chainEditing = a.dataset.editBasis; renderChainTab(); });
  ed.querySelectorAll("[data-rm-link]").forEach((b) =>
    b.onclick = () => deleteLink(b.dataset.rmLink));
  ed.querySelectorAll("[data-focus-claim]").forEach((a) =>
    a.onclick = (e) => { e.preventDefault(); focusClaim(a.dataset.focusClaim); });
  $("#btnOpenGraph").onclick = () => openGraph({ kind: "evidence", id: ev.id });
  $("#btnGraphFromEv").onclick = () => openGraph({ kind: "evidence", id: ev.id });
  $("#btnDelEv").onclick = () => { deleteEvidence(ev.id); renderChainTab(); };
  bindFocusChips(ed);
}

/* 添加关联对象：从当前叶件/双叶/书帖中选择 */
function pickSubject(ev) {
  const leafOpts = state.doc.leaves.map((l) => `<option value="l:${l.id}">叶：${esc(leafLabel(l))}</option>`).join("");
  const pairOpts = state.doc.pairs.map((p) => {
    const la = leafById(p.a), lb = leafById(p.b);
    return `<option value="p:${p.id}">双叶：${esc(la ? leafLabel(la) : "?")} ⌒ ${esc(lb ? leafLabel(lb) : "?")}</option>`;
  }).join("");
  const quireOpts = state.doc.quires.map((q) => `<option value="q:${q.id}">帖：${esc(q.name)}</option>`).join("");
  openMini({
    title: "关联到对象",
    body: `<p class="muted">证据可关联线孔、折痕、接缝、叶码连续或纸张特征所属的叶件 / 双叶 / 书帖。</p>
      <select id="subjectPick" style="width:100%;padding:6px">
        <option value="">— 选择对象 —</option>
        <optgroup label="叶件 / 残片">${leafOpts}</optgroup>
        ${pairOpts ? `<optgroup label="双叶">${pairOpts}</optgroup>` : ""}
        ${quireOpts ? `<optgroup label="书帖">${quireOpts}</optgroup>` : ""}
      </select>`,
    actions: [
      { label: "取消", ghost: true },
      { label: "关联", primary: true, fn: () => {
        const v = $("#subjectPick").value;
        if (!v) return;
        if (!(ev.subjects || []).includes(v)) updateEvidence(ev.id, { subjects: [...(ev.subjects || []), v] }, "关联对象 " + v);
      } },
    ],
  });
}

/* 详情面板：对象已关联的独立证据记录 */
function relatedEvidenceHTML(subjectId) {
  const evs = activeEvidences(state.doc).filter((e) => (e.subjects || []).includes(subjectId));
  if (!evs.length) return "";
  return `<div class="detail-section"><h3>关联证据记录（${evs.length}）</h3>
    ${evs.map((ev) => {
      const fl = state.chainAnalysis.flags.ev.get(ev.id) || [];
      return `<div class="rel-ev ${fl.length ? "flag" : ""}" data-open-ev="${ev.id}"
        title="${esc(fl.map((f) => f.msg).join("\n"))}">
        <span class="cr-kind k-${ev.kind}">${EV_TYPES[ev.kind]?.icon || "他"}</span>
        <span>${esc(ev.title)}</span>
        <span class="${ev.status === "confirmed" ? "cr-confirmed" : "cr-pending"}">${EV_STATUS[ev.status]}</span>
        ${fl.length ? '<span class="chain-bad err">冲突</span>' : ""}
      </div>`;
    }).join("")}</div>`;
}

/* 反向定位：点对象徽标 → 选中画布对象 */
function bindFocusChips(container) {
  container.querySelectorAll("[data-focus]").forEach((a) =>
    a.onclick = (e) => {
      e.preventDefault();
      focusObject(JSON.parse(a.dataset.focus));
    });
}
function focusObject(ref, silent = false) {
  if (!ref || !ref.kind) return;
  state.selection = { kind: ref.kind, id: ref.id };
  setView("all");
  renderAll();
  switchRightTab("detail");
  if (!silent) toast("已反向定位画布对象", 900);
  // 滚动到中栏对应元素
  requestAnimationFrame(() => {
    const attr = ref.kind === "pair" ? "[data-pair='" + ref.id + "']"
      : ref.kind === "quire" ? "[data-quire='" + ref.id + "']"
      : "[data-leaf='" + ref.id + "']";
    const el = $("#sectionView").querySelector(attr) || $("#cardsView").querySelector(attr) ||
      $("#stripView").querySelector(attr);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  });
}
/* 从结论反向定位：系统结论直接落到对应对象 */
function focusClaim(claimId) {
  const cl = state.chainAnalysis.claimsById.get(claimId);
  if (!cl) { toast("结论已删除（悬空，仅标记）"); return; }
  if (cl.kind === "pair") {
    if (cl.pairId) focusObject({ kind: "pair", id: cl.pairId });
  } else if (cl.kind === "place") {
    if (cl.system) focusObject({ kind: "leaf", id: cl.refs[1] });
    else focusObject({ kind: "leaf", id: cl.leaf });
  } else if (cl.kind === "order") {
    const lid = cl.system ? cl.refs[1] : cl.a;
    focusObject({ kind: "leaf", id: lid });
  } else {
    toast("该结论为自由备注，无对应画布对象");
  }
}

$("#btnAddEvidence").onclick = () => {
  // 若当前选中叶件/双叶，预填关联对象
  const pre = {};
  const sel = state.selection;
  if (sel?.kind === "leaf") pre.subjects = ["l:" + sel.id];
  if (sel?.kind === "pair") pre.subjects = ["p:" + sel.id];
  if (sel?.kind === "quire") pre.subjects = ["q:" + sel.id];
  const id = addEvidence(pre);
  state.chainEditing = id;
  renderChainTab();
  switchRightTab("chain");
};
$("#btnGraphAll").onclick = () => { openGraph(null); switchRightTab("chain"); };

/* ============================================================
   通用确认/预览小弹窗
   ============================================================ */
function openMini({ title, body, actions }) {
  $("#miniTitle").textContent = title || "确认";
  $("#miniBody").innerHTML = body || "";
  const foot = $("#miniFoot");
  foot.innerHTML = "";
  (actions || []).forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn small " + (a.ghost ? "ghost light" : a.danger ? "danger" : "");
    b.textContent = a.label;
    b.onclick = () => {
      if (a.fn) a.fn();
      $("#miniModal").classList.add("hidden");
    };
    foot.appendChild(b);
  });
  $("#miniModal").classList.remove("hidden");
}

/* ============================================================
   证据链关系图（SVG：证据节点 / 结论节点 / 对象节点，力导向）
   ============================================================ */
const graph = {
  nodes: [], edges: [], pos: new Map(), sim: null,
  transform: { x: 0, y: 0, k: 1 },
  dragNode: null, panning: null, tempLink: null, selEdge: null,
  mergePicked: [],
};

function openGraph(scope) {
  state.graphScope = scope;
  state.graphExpand = false;
  state.graphMerge = false;
  graph.mergePicked = [];
  buildGraphData();
  $("#graphModal").classList.remove("hidden");
  renderGraphFrame();
  runLayout(true);
}

/* 计算图范围与节点边集合 */
function buildGraphData() {
  const doc = state.doc;
  const an = state.chainAnalysis;
  const scope = state.graphScope;
  const objIds = new Set();      // 画布对象节点 l:/p:/q:
  const seedEv = new Set();      // 起点证据
  let rootClaim = null;

  if (scope?.kind === "leaf") objIds.add("l:" + scope.id);
  if (scope?.kind === "pair") objIds.add("p:" + scope.id);
  if (scope?.kind === "quire") objIds.add("q:" + scope.id);
  if (scope?.kind === "evidence") seedEv.add(scope.id);
  if (scope?.kind === "claim") rootClaim = scope.id;

  // 对象范围：收集与该对象直接关联的证据；双叶同时带入其两个半叶
  if (scope?.kind === "pair") {
    const p = doc.pairs.find((x) => x.id === scope.id);
    if (p) { objIds.add("l:" + p.a); objIds.add("l:" + p.b); }
  }
  if (scope?.kind === "leaf") {
    // 该叶所属双叶也带入
    const p = (doc.pairs || []).find((x) => x.a === scope.id || x.b === scope.id);
    if (p) { objIds.add("p:" + p.id); objIds.add("l:" + (p.a === scope.id ? p.b : p.a)); }
  }
  if (objIds.size) {
    activeEvidences(doc).forEach((e) => {
      if ((e.subjects || []).some((s) => objIds.has(s))) seedEv.add(e.id);
    });
    // 引用了涉及该对象之结论的证据（如候选配叶引用本叶）
    an.claimsById.forEach((cl, cid) => {
      const touches = (cl.refs || []).some((r, i) => {
        if (i === 0 || r == null) return false;
        return objIds.has("l:" + r) || objIds.has("q:" + r);
      }) || (cl.pairId && objIds.has("p:" + cl.pairId));
      if (touches) {
        doc.links.forEach((lk) => { if (lk.target === cid) seedEv.add(lk.evidence); });
      }
    });
  }
  if (rootClaim) {
    for (const lk of doc.links) if (lk.target === rootClaim) seedEv.add(lk.evidence);
  }

  // 推导依据：默认带一层；展开模式递归全部
  const grow = (id) => {
    const ev0 = evidenceById(id, doc);
    for (const b of ev0?.basis || []) {
      if (!seedEv.has(b)) { seedEv.add(b); if (state.graphExpand) grow(b); }
    }
  };
  [...seedEv].forEach(grow);
  // 全图模式（无范围）包含全部证据
  const noScope = !scope;
  const evs = activeEvidences(doc).filter((e) => noScope || seedEv.has(e.id));
  const evIds = new Set(evs.map((e) => e.id));

  // 证据关联的对象
  evs.forEach((e) => (e.subjects || []).forEach((s) => objIds.add(s)));

  // 关系涉及的结论
  const claimIds = new Set();
  doc.links.forEach((lk) => {
    if (!evIds.has(lk.evidence)) return;
    if (an.claimsById.has(lk.target)) claimIds.add(lk.target);
    else claimIds.add("ghost:" + lk.target); // 已删除结论
  });
  if (rootClaim) claimIds.add(rootClaim);

  // 候选/系统结论引用的对象（便于在图上反查）
  claimIds.forEach((cid) => {
    if (cid.startsWith("ghost:")) return;
    const cl = an.claimsById.get(cid);
    if (!cl) return;
    (cl.refs || []).forEach((r, i) => {
      if (i === 0 || r == null) return;
      if (cl.refs[0] === "pair" || cl.refs[0] === "order") objIds.add("l:" + r);
      if (cl.refs[0] === "leaf") objIds.add(i === 1 ? "l:" + r : "q:" + r);
    });
    if (cl.pairId) objIds.add("p:" + cl.pairId);
  });

  // 节点
  const nodes = [];
  objIds.forEach((oid) => {
    let label = oid, kind = "object", subkind = "leaf", ref = null, dead = false;
    if (oid.startsWith("l:")) {
      const l = leafById(oid.slice(2));
      label = l ? leafLabel(l) : "已删叶"; subkind = l?.frag ? "frag" : "leaf";
      ref = { kind: "leaf", id: oid.slice(2) }; dead = !l;
    } else if (oid.startsWith("p:")) {
      const p = doc.pairs.find((x) => x.id === oid.slice(2));
      label = p ? "双叶 " + (leafById(p.a) ? leafLabel(leafById(p.a)) : "?") + "⌒" +
        (leafById(p.b) ? leafLabel(leafById(p.b)) : "?") : "已删双叶";
      subkind = "pair"; ref = p ? { kind: "pair", id: p.id } : null; dead = !p;
    } else if (oid.startsWith("q:")) {
      const q = quireById(oid.slice(2));
      label = q ? "帖「" + q.name + "」" : "已删帖";
      subkind = "quire"; ref = q ? { kind: "quire", id: q.id } : null; dead = !q;
    }
    nodes.push({ id: oid, ntype: "object", subkind, label, ref, dead });
  });
  evs.forEach((ev) => nodes.push({
    id: ev.id, ntype: "evidence", kind: ev.kind, label: ev.title,
    status: ev.status, credibility: ev.credibility,
    flags: an.flags.ev.get(ev.id) || [],
  }));
  claimIds.forEach((cid) => {
    if (cid.startsWith("ghost:")) {
      nodes.push({ id: cid, ntype: "claim", subkind: "ghost", label: "已删除的结论", dead: true, ghost: true });
      return;
    }
    const cl = an.claimsById.get(cid);
    if (!cl) return;
    nodes.push({
      id: cid, ntype: "claim",
      subkind: cl.system ? cl.kind : "candidate-" + cl.kind,
      label: cl.label, system: cl.system, dead: cl.exists === false,
      conflicts: an.claimConflict.get(cid)?.length || 0,
    });
  });

  // 边：对象—证据（关联）、证据—结论（支持/反驳/虚线依据）
  const edges = [];
  evs.forEach((ev) => {
    (ev.subjects || []).forEach((s) => {
      if (objIds.has(s)) edges.push({ id: "subj:" + ev.id + ":" + s, kind: "subject", from: s, to: ev.id });
    });
    (ev.basis || []).forEach((b) => {
      if (evIds.has(b)) edges.push({ id: "basis:" + b + ":" + ev.id, kind: "basis", from: b, to: ev.id });
    });
  });
  doc.links.forEach((lk) => {
    if (!evIds.has(lk.evidence)) return;
    const target = an.claimsById.has(lk.target) ? lk.target : "ghost:" + lk.target;
    if (!claimIds.has(target)) return;
    edges.push({ id: lk.id, kind: "link", stance: lk.stance, from: lk.evidence, to: target,
      flags: an.flags.link.get(lk.id) || [] });
  });

  graph.nodes = nodes;
  graph.edges = edges;

  // 标题
  const titles = [];
  if (scope?.kind === "leaf") titles.push(leafById(scope.id) ? leafLabel(leafById(scope.id)) : "叶件");
  if (scope?.kind === "pair") titles.push("双叶");
  if (scope?.kind === "quire") titles.push("帖「" + (quireById(scope.id)?.name || "") + "」");
  if (scope?.kind === "evidence") titles.push(evidenceById(scope.id)?.title || "证据");
  if (scope?.kind === "claim") titles.push(an.claimsById.get(scope.id)?.label || "结论");
  $("#graphTitle").textContent = "证据链关系图" + (titles.length ? " · " + titles[0] : "（全部记录）");
}

/* 三列初始布局 + 力导向 */
function runLayout(initial) {
  const W = Math.max(900, graph.nodes.length * 120 + 200);
  const H = Math.max(520, graph.nodes.length * 60 + 120);
  graph.W = W; graph.H = H;
  const cols = { object: [], evidence: [], claim: [] };
  graph.nodes.forEach((n) => cols[n.ntype].push(n));
  const placeCol = (arr, x) => {
    arr.forEach((n, i) => {
      const y = 80 + i * 92 + (n.ntype === "evidence" && i % 2 ? 30 : 0);
      if (initial || !graph.pos.has(n.id)) graph.pos.set(n.id, { x, y: Math.min(y, H - 60) });
    });
  };
  placeCol(cols.object, 150);
  placeCol(cols.evidence, W / 2);
  placeCol(cols.claim, W - 170);
  simulate();
  drawGraph();
}

function simulate(iterations = 240) {
  const pos = graph.pos, nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const k = 150;
  for (let it = 0; it < iterations; it++) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    // 斥力
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy; if (d2 < 0.01) { d2 = 0.01; dx = 0.1; }
        const d = Math.sqrt(d2), f = (k * k) / d;
        const ux = dx / d, uy = dy / d;
        disp.get(nodes[i].id).x += ux * f; disp.get(nodes[i].id).y += uy * f;
        disp.get(nodes[j].id).x -= ux * f; disp.get(nodes[j].id).y -= uy * f;
      }
    }
    // 弹力（沿边）
    graph.edges.forEach((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
      const rest = e.kind === "basis" ? 130 : 120;
      const f = (d * d) / (rest * k) * 0.6;
      const ux = dx / d * f, uy = dy / d * f;
      disp.get(e.from).x += ux; disp.get(e.from).y += uy;
      disp.get(e.to).x -= ux; disp.get(e.to).y -= uy;
    });
    // 列向重力：保持对象-证据-结论三列
    nodes.forEach((n) => {
      const p = disp.get(n.id), q = pos.get(n.id);
      const targetX = n.ntype === "object" ? 150 : n.ntype === "evidence" ? graph.W / 2 : graph.W - 170;
      p.x += (targetX - q.x) * 0.02;
      p.y += (graph.H / 2 - q.y) * 0.012;
    });
    const t = 1 - it / iterations * 0.7;
    nodes.forEach((n) => {
      if (graph.dragNode === n.id) return;
      const p = pos.get(n.id), dd = disp.get(n.id);
      p.x = Math.max(60, Math.min(graph.W - 60, p.x + dd.x * 0.02 * t));
      p.y = Math.max(40, Math.min(graph.H - 40, p.y + dd.y * 0.02 * t));
    });
  }
}

function renderGraphFrame() {
  $("#btnGraphMerge").classList.toggle("on-conf", state.graphMerge);
  $("#btnExpandGraph").classList.toggle("on-conf", state.graphExpand);
  const hint = state.graphMerge
    ? "合并模式：依次点击两条证据记录，后者将并入前者（关系迁移、旧记录归档保留版本）。"
    : "从证据节点拖线到结论节点建立「支持」；按住 Alt 拖线为「反驳」。点对象节点反向定位画布。";
  $("#graphHint").textContent = hint;
}

function nodeHTML(n) {
  const p = graph.pos.get(n.id);
  const flags = n.flags || [];
  const conflict = flags.length || n.conflicts;
  let cls = "gnode g-" + n.ntype;
  if (n.subkind) cls += " g-" + n.subkind;
  if (n.dead) cls += " g-dead";
  if (n.status === "confirmed") cls += " g-confirmed";
  if (conflict) cls += " g-flag";
  if (state.graphMerge && n.ntype === "evidence") cls += " g-mergeable";
  if (graph.mergePicked.includes(n.id)) cls += " g-merge-pick";
  const badges = [];
  if (n.ntype === "evidence") {
    badges.push(`<span class="gn-kind k-${n.kind}">${EV_TYPES[n.kind]?.icon || "他"}</span>`);
    if (n.status === "confirmed") badges.push('<span class="gn-bad ok">确</span>');
    else badges.push('<span class="gn-bad warn">疑</span>');
  }
  if (n.ntype === "claim") badges.push(n.system ? '<span class="gn-bad sys">现结构</span>' : '<span class="gn-bad cand">候选</span>');
  if (conflict) badges.push('<span class="gn-bad err">!</span>');
  if (n.dead) badges.push('<span class="gn-bad dead">悬空</span>');
  return `<g class="${cls}" data-node="${n.id}" transform="translate(${p.x},${p.y})" style="cursor:${n.ntype === "evidence" && state.graphMerge ? "pointer" : "grab"}">
    <rect x="-70" y="-22" width="140" height="44" rx="6"></rect>
    <text class="gn-label" x="0" y="-3" text-anchor="middle">${esc(n.label).slice(0, 26)}</text>
    <text class="gn-sub" x="0" y="13" text-anchor="middle">${badges.join(" ")}</text>
  </g>`;
}

function edgePath(e) {
  const a = graph.pos.get(e.from), b = graph.pos.get(e.to);
  if (!a || !b) return "";
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
  const gap = 74;
  const x1 = a.x + dx / d * gap, y1 = a.y + dy / d * gap;
  const x2 = b.x - dx / d * gap, y2 = b.y - dy / d * gap;
  // 贝塞尔微弯
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const nx = -dy / d * 14, ny = dx / d * 14;
  return { d: `M ${x1} ${y1} Q ${mx + nx} ${my + ny} ${x2} ${y2}`, x1, y1, x2, y2, cx: mx + nx, cy: my + ny };
}

function drawGraph() {
  const body = $("#graphBody");
  const an = state.chainAnalysis;
  let edgeSvg = "", labelLayer = "";
  graph.edges.forEach((e) => {
    const path = edgePath(e);
    if (!path) return;
    let cls = "gedge";
    let marker = "";
    if (e.kind === "subject") { cls += " ge-subject"; }
    else if (e.kind === "basis") { cls += " ge-basis"; marker = 'marker-end="url(#arrowBasis)"'; }
    else {
      cls += e.stance === "support" ? " ge-support" : " ge-refute";
      marker = `marker-end="url(#arrow${e.stance === "support" ? "Sup" : "Ref"})"`;
    }
    if ((e.flags || []).length) cls += " ge-flag";
    if (graph.selEdge === e.id) cls += " ge-sel";
    edgeSvg += `<path class="${cls}" d="${path.d}" ${marker} data-edge="${e.id}" fill="none"/>`;
    if (e.kind === "link") {
      const tag = e.stance === "support" ? "支持" : "反驳";
      const flagged = (e.flags || []).length;
      labelLayer += `<g class="edge-tag" data-edge="${e.id}" style="cursor:pointer">
        <circle cx="${path.cx}" cy="${path.cy}" r="3" fill="transparent"/>
        <text x="${path.cx}" y="${path.cy + 3}" text-anchor="middle"
          class="etag ${e.stance} ${flagged ? "flag" : ""}">${tag}${flagged ? " ⚠" : ""}</text></g>`;
    }
  });
  const nodeSvg = graph.nodes.map(nodeHTML).join("");

  body.innerHTML = `
    <div class="graph-legend">
      <span><i class="gl-o"></i>画布对象（点击反向定位）</span>
      <span><i class="gl-e"></i>证据记录</span>
      <span><i class="gl-c"></i>结论：现结构 / 候选</span>
      <span><b class="lg-sup">▲</b> 支持</span>
      <span><b class="lg-ref">▼</b> 反驳</span>
      <span class="muted">┄ 推导依据 / 关联</span>
      <span class="lg-flag">红框 = 冲突标记（互斥·悬空·循环）</span>
    </div>
    <svg id="graphSvg" width="100%" height="100%" viewBox="0 0 ${graph.W} ${graph.H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrowSup" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#3e7d4f"/></marker>
        <marker id="arrowRef" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#b3382c"/></marker>
        <marker id="arrowBasis" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#a99d8b"/></marker>
      </defs>
      <g id="graphWorld">
        <g id="edgeLayer">${edgeSvg}</g>
        <g id="nodeLayer">${nodeSvg}</g>
        ${labelLayer}
        <path id="tempLink" class="temp-link" d="" fill="none" style="display:none"/>
      </g>
    </svg>`;
  bindGraphEvents();
  applyWorld();
}

/* 交互状态：窗口级监听只注册一次，拖拽中只更新坐标、不重建 SVG */
const graphPointer = { mode: null, node: null, start: null, moved: false, alt: false };
let graphEventsBound = false;
function bindGraphEvents() {
  const svg = $("#graphSvg");
  if (!graphEventsBound) {
    svg.addEventListener("wheel", (e) => {
      if ($("#graphModal").classList.contains("hidden")) return;
      e.preventDefault();
      const k = graph.transform.k * (e.deltaY < 0 ? 1.1 : 0.9);
      graph.transform.k = Math.max(0.4, Math.min(2.2, k));
      applyWorld();
    }, { passive: false });

    svg.addEventListener("mousedown", (e) => {
      const ng = e.target.closest("[data-node]");
      if (ng) {
        const node = graph.nodes.find((n) => n.id === ng.dataset.node);
        graphPointer.mode = e.altKey && node.ntype === "evidence" ? "link" : "node";
        graphPointer.node = node;
        graphPointer.start = { x: e.clientX, y: e.clientY,
          nx: graph.pos.get(node.id).x, ny: graph.pos.get(node.id).y };
        graphPointer.moved = false; graphPointer.alt = e.altKey;
        e.preventDefault();
        return;
      }
      if (e.target.closest("[data-edge]")) return; // click 监听里处理
      graphPointer.mode = "pan";
      graphPointer.start = { x: e.clientX, y: e.clientY, tx: graph.transform.x, ty: graph.transform.y };
    });

    window.addEventListener("mousemove", (e) => {
      if ($("#graphModal").classList.contains("hidden")) return;
      const gp = graphPointer;
      if (!gp.mode || !gp.start) return;
      const dx = e.clientX - gp.start.x, dy = e.clientY - gp.start.y;
      if (gp.mode === "pan") {
        graph.transform.x = gp.start.tx + dx;
        graph.transform.y = gp.start.ty + dy;
        applyWorld();
        return;
      }
      if (Math.hypot(dx, dy) < 5) return;
      gp.moved = true;
      const pos = graph.pos.get(gp.node.id);
      if (gp.mode === "link") {
        const pt = clientToWorld(e.clientX, e.clientY);
        const tl = $("#tempLink");
        if (tl) {
          tl.style.display = "";
          tl.setAttribute("class", "temp-link " + (e.altKey ? "refute" : "support"));
          tl.setAttribute("marker-end", "url(#arrow" + (e.altKey ? "Ref" : "Sup") + ")");
          tl.setAttribute("d",
            `M ${pos.x + 40} ${pos.y} Q ${(pos.x + pt.x) / 2} ${(pos.y + pt.y) / 2 - 30} ${pt.x} ${pt.y}`);
        }
      } else {
        pos.x = Math.max(60, Math.min(graph.W - 60, gp.start.nx + dx / graph.transform.k));
        pos.y = Math.max(40, Math.min(graph.H - 40, gp.start.ny + dy / graph.transform.k));
        updateNodeTransform(gp.node.id, pos);
        updateNodeEdges(gp.node.id);
      }
    });

    window.addEventListener("mouseup", (e) => {
      if ($("#graphModal").classList.contains("hidden")) return;
      const gp = graphPointer;
      if (!gp.mode) return;
      const tl = $("#tempLink");
      if (tl) tl.style.display = "none";
      if (gp.mode === "node" || gp.mode === "link") {
        if (!gp.moved) handleNodeClick(gp.node, e);
        else if (gp.mode === "link") {
          // Alt+拖线：证据节点拉线落到结论节点，建立支持（默认）/反驳（Alt）
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node]");
          const tn = target ? graph.nodes.find((n) => n.id === target.dataset.node) : null;
          if (tn && tn.id !== gp.node.id && tn.ntype === "claim")
            beforeAddLink(gp.node.id, tn, e.altKey ? "refute" : "support");
        } else if (gp.mode === "node" && gp.node.ntype === "evidence") {
          // 普通拖动证据节点落到另一证据 = 添加推导依据
          const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node]");
          const tn = target ? graph.nodes.find((n) => n.id === target.dataset.node) : null;
          if (tn && tn.ntype === "evidence" && tn.id !== gp.node.id) {
            const cur = evidenceById(gp.node.id).basis || [];
            updateEvidence(gp.node.id, { basis: [...new Set([...cur, tn.id])] },
              "添加推导依据：" + evidenceById(tn.id).title);
          }
        }
      }
      graphPointer.mode = null; graphPointer.node = null; graphPointer.start = null;
    });

    svg.addEventListener("dblclick", (e) => {
      const ng = e.target.closest("[data-node]");
      if (!ng) return;
      const node = graph.nodes.find((n) => n.id === ng.dataset.node);
      if (node.ntype === "evidence") {
        $("#graphModal").classList.add("hidden");
        state.chainEditing = node.id;
        switchRightTab("chain");
        renderChainTab();
      } else if (node.ntype === "claim" && !node.system && !node.ghost) {
        if (confirm("删除候选结论「" + node.label + "」？")) deleteUserClaim(node.id);
      }
    });

    svg.addEventListener("click", (e) => {
      const edgeEl = e.target.closest("[data-edge]");
      if (!edgeEl) return;
      const id = edgeEl.dataset.edge;
      if (!id.startsWith("lk")) return;
      const lk = state.doc.links.find((x) => x.id === id);
      if (!lk) return;
      const cl = state.chainAnalysis.claimsById.get(lk.target);
      const fl = state.chainAnalysis.flags.link.get(id) || [];
      openMini({
        title: STANCE_LABEL[lk.stance] + "关系",
        body: `<p>证据 <b>${esc(evidenceById(lk.evidence)?.title || "?")}</b>
            ${lk.stance === "support" ? "支持" : "反驳"} <b>${esc(cl?.label || chainTargetLabel(state.doc, lk.target))}</b></p>
          ${fl.length ? `<div class="mini-sub err">冲突标记</div><ul class="mini-list">
            ${[...new Set(fl.map((f) => f.msg))].map((m) => `<li class="err">${esc(m)}</li>`).join("")}</ul>` : ""}
          <p class="muted">冲突只标记、不改动结构。</p>`,
        actions: [
          { label: "关闭", ghost: true },
          { label: "删除关系", danger: true, fn: () => deleteLink(id) },
        ],
      });
    });
    graphEventsBound = true;
  }
}

/* 拖拽中局部更新，避免整图重建造成元素被销毁 */
function updateNodeTransform(id, pos) {
  const g = $("#graphSvg")?.querySelector(`[data-node="${id}"]`);
  if (g) g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
}
function updateNodeEdges(id) {
  const svg = $("#graphSvg");
  if (!svg) return;
  graph.edges.forEach((e0) => {
    if (e0.from !== id && e0.to !== id) return;
    const path = edgePath(e0);
    const el = svg.querySelector(`path[data-edge="${e0.id}"]`);
    if (el && path) el.setAttribute("d", path.d);
    const tag = svg.querySelector(`.edge-tag[data-edge="${e0.id}"] text`);
    if (tag && path) tag.setAttribute("x", path.cx), tag.setAttribute("y", path.cy + 3);
    const dot = svg.querySelector(`.edge-tag[data-edge="${e0.id}"] circle`);
    if (dot && path) dot.setAttribute("cx", path.cx), dot.setAttribute("cy", path.cy);
  });
}

function applyWorld() {
  const w = $("#graphWorld");
  if (w) w.setAttribute("transform",
    `translate(${graph.transform.x},${graph.transform.y}) scale(${graph.transform.k})`);
}
/* 屏幕坐标 → 图内坐标：先经 meet 等比映射，再扣除平移/缩放 */
function clientToWorld(cx, cy) {
  const svg = $("#graphSvg");
  const r = svg.getBoundingClientRect();
  const base = Math.min(r.width / graph.W, r.height / graph.H);
  const ox = (r.width - graph.W * base) / 2;
  const oy = (r.height - graph.H * base) / 2;
  return {
    x: (cx - r.left - ox - graph.transform.x) / (base * graph.transform.k),
    y: (cy - r.top - oy - graph.transform.y) / (base * graph.transform.k),
  };
}

/* 节点单击：对象=反向定位；证据=合并选择/选中；结论=提示 */
function handleNodeClick(node, e) {
  if (state.graphMerge && node.ntype === "evidence") {
    if (graph.mergePicked.includes(node.id)) {
      graph.mergePicked = graph.mergePicked.filter((x) => x !== node.id);
    } else {
      graph.mergePicked.push(node.id);
      if (graph.mergePicked.length === 2) {
        const [keep, absorb] = graph.mergePicked;
        openMini({
          title: "合并重复证据记录",
          body: `<p>保留：<b>${esc(evidenceById(keep).title)}</b><br>
              并入（归档）：<b>${esc(evidenceById(absorb).title)}</b></p>
            <p class="muted">后者的支持/反驳关系将迁移到前者，重复关系自动去重；
              旧记录标记归档并保留全部版本，仍可在列表底部追溯。</p>`,
          actions: [
            { label: "取消", ghost: true, fn: () => { graph.mergePicked = []; } },
            { label: "确认合并", primary: true, fn: () => {
              mergeEvidence(keep, absorb);
              graph.mergePicked = [];
              state.graphMerge = false;
              buildGraphData(); renderGraphFrame(); runLayout(false);
            } },
          ],
        });
        return;
      }
    }
    drawGraph();
    return;
  }
  if (node.ntype === "object" && node.ref) {
    $("#graphModal").classList.add("hidden");
    focusObject(node.ref);
    return;
  }
  if (node.ntype === "claim") {
    if (node.dead) { toast("悬空结论：引用对象已删除（只标记，不改动）", 2600); return; }
    // 现结构结论：关闭图并反向定位到画布对象；候选结论：提示其性质与引用数
    if (node.system) { $("#graphModal").classList.add("hidden"); focusClaim(node.id); }
    else {
      const n = state.doc.links.filter((l) => l.target === node.id).length;
      toast("候选结论（双击可删除），现有 " + n + " 条证据关系；反向定位请打开其关联叶件", 2600);
    }
    return;
  }
  if (node.ntype === "evidence") {
    const fl = state.chainAnalysis.flags.ev.get(node.id) || [];
    if (fl.length) toast(fl[0].msg, 2800);
  }
}

/* 建立关系前：若产生冲突先预览；同时展示该结论当前证据态势 */
function beforeAddLink(evId, targetNode, stance) {
  const cl = state.chainAnalysis.claimsById.get(targetNode.id);
  const trial = clone(state.doc);
  trial.links.push({ id: "new", evidence: evId, target: targetNode.id, stance, created_at: "" });
  const ta = chainAnalysis(trial);
  const newFlags = ta.flags.link.get("new") || [];
  const sameStance = state.doc.links.filter((l) => l.target === targetNode.id && l.stance === stance).length;
  const oppStance = state.doc.links.filter((l) => l.target === targetNode.id && l.stance !== stance).length;
  openMini({
    title: (stance === "support" ? "支持" : "反驳") + "：" + (cl?.label || targetNode.label),
    body: `<p>证据 <b>${esc(evidenceById(evId).title)}</b> 将对该结论建立「${stance === "support" ? "支持" : "反驳"}」关系。</p>
      <p class="muted">该结论现有：${sameStance} 条${stance === "support" ? "支持" : "反驳"}、${oppStance} 条${stance === "support" ? "反驳" : "支持"}。</p>
      ${newFlags.length ? `<div class="mini-sub err">建立后将出现冲突标记（不改动结构）</div>
        <ul class="mini-list">${newFlags.map((f) => `<li class="err">${esc(f.msg)}</li>`).join("")}</ul>`
        : '<p style="color:var(--ok)">未引入互斥/悬空冲突。</p>'}`,
    actions: [
      { label: "取消", ghost: true },
      { label: "确认建立", primary: true, fn: () => addLink(evId, targetNode.id, stance) },
    ],
  });
}

/* 工具栏 */
$("#btnExpandGraph").onclick = () => {
  state.graphExpand = !state.graphExpand;
  buildGraphData(); renderGraphFrame(); runLayout(true);
};
$("#btnResetView").onclick = () => { graph.transform = { x: 0, y: 0, k: 1 }; runLayout(true); applyWorld(); };
$("#btnGraphMerge").onclick = () => {
  state.graphMerge = !state.graphMerge;
  graph.mergePicked = [];
  renderGraphFrame(); drawGraph();
};
$("#btnAddClaim").onclick = () => {
  const leafOpts = state.doc.leaves.map((l) => `<option value="${l.id}">${esc(leafLabel(l))}</option>`).join("");
  const quireOpts = state.doc.quires.map((q) => `<option value="${q.id}">${esc(q.name)}</option>`).join("");
  openMini({
    title: "新增候选结论",
    body: `<div class="field"><label>类型</label><select id="mcKind">
        <option value="pair">配叶（哪两叶成一双）</option>
        <option value="place">层位（某叶置入某帖某位）</option>
        <option value="order">叶序（某叶应在某叶之前）</option>
        <option value="note">其他结论（自由记述）</option>
      </select></div>
      <div id="mcPairBody" class="mc-body">
        <div class="field"><label>叶 A</label><select id="mcA">${leafOpts}</select></div>
        <div class="field"><label>叶 B</label><select id="mcB">${leafOpts}</select></div>
      </div>
      <div id="mcPlaceBody" class="mc-body hidden">
        <div class="field"><label>叶</label><select id="mcLeaf">${leafOpts}</select></div>
        <div class="field"><label>书帖</label><select id="mcQ">${quireOpts}</select></div>
        <div class="field"><label>位</label><input type="number" id="mcPos" min="0" value="0"></div>
      </div>
      <div id="mcOrderBody" class="mc-body hidden">
        <div class="field"><label>前叶</label><select id="mcOA">${leafOpts}</select></div>
        <div class="field"><label>后叶</label><select id="mcOB">${leafOpts}</select></div>
      </div>
      <div id="mcNoteBody" class="mc-body hidden">
        <div class="field"><label>结论</label><input type="text" id="mcText" placeholder="如：该卷原经蝴蝶装改装"></div>
      </div>
      <div class="field"><label>说明</label><input type="text" id="mcNote" placeholder="可选备注"></div>`,
    actions: [
      { label: "取消", ghost: true },
      { label: "建立结论", primary: true, fn: () => {
        const kind = $("#mcKind").value;
        const note = $("#mcNote").value;
        let claim;
        if (kind === "pair") {
          const a = $("#mcA").value, b = $("#mcB").value;
          if (a === b) return toast("须选两叶不同的叶");
          claim = { kind: "pair", a, b, note };
        } else if (kind === "place") {
          claim = { kind: "place", leaf: $("#mcLeaf").value, qid: $("#mcQ").value, pos: +$("#mcPos").value || 0, note };
        } else if (kind === "order") {
          const a = $("#mcOA").value, b = $("#mcOB").value;
          if (a === b) return toast("须选两叶不同的叶");
          claim = { kind: "order", a, b, note };
        } else {
          claim = { kind: "note", text: $("#mcText").value || "未命名结论", note };
        }
        const id = addUserClaim(claim);
        buildGraphData(); runLayout(true);
      } },
    ],
  });
  $("#mcKind").onchange = (e) => {
    ["Pair", "Place", "Order", "Note"].forEach((s) =>
      $("#mc" + s + "Body").classList.toggle("hidden", e.target.value !== s.toLowerCase()));
  };
};
$("#graphModal").addEventListener("click", (e) => {
  if (e.target.id === "graphModal") { e.target.classList.add("hidden"); state.graphMerge = false; }
});

/* ============================================================
   残片候选位置筛选
   ============================================================ */
function fragmentCandidates(fragId) {
  const frag = leafById(fragId);
  if (!frag) return [];
  const out = [];
  let excluded = 0; // 被排除（会新增结构冲突）的落点计数

  // 以「问题身份」（类型 + 涉及对象，不含位置文案——插入会改变层位/序号表述）
  // 统计 err 级问题数量；插入后任何身份计数增加，都算该落点引入了新的结构冲突。
  function errCounts(list) {
    const m = new Map();
    for (const x of list) {
      if (x.sev !== "err") continue;
      const k = [x.type, x.qid || "", x.lid || "", x.pid || ""].join("|");
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  function simulate(qId, index) {
    const d = clone(state.doc);
    d.quires.forEach((q) => (q.leaves = q.leaves.filter((x) => x !== fragId)));
    const before = errCounts(validate(d)); // 先算“取出残片后”的基线
    if (qId) {
      const q = d.quires.find((q) => q.id === qId);
      q.leaves.splice(Math.min(index, q.leaves.length), 0, fragId);
    } else {
      d.quires.push({ id: "newq", name: "新帖", locked: false, leaves: [fragId] });
    }
    const after = errCounts(validate(d));
    let added = 0;
    for (const [k, c] of after) added += Math.max(0, c - (before.get(k) || 0));
    return added;
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
      const added = simulate(q.id, i);
      if (added > 0) { excluded++; continue; } // 该落点会新增结构冲突，排除
      const why = justify(q, i);
      out.push({
        qId: q.id, qName: q.name, index: i,
        pos: i === 0 ? "帖首" : i === q.leaves.length ? "帖末（第" + i + "叶后）" : "第" + i + "叶与第" + (i + 1) + "叶之间",
        why, weak: why.length === 0,
      });
    }
  }
  out.excluded = excluded;
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
  if (!state.chainAnalysis) recomputeChain();
  renderTray();
  renderSection();
  renderStrip();
  renderCards();
  renderDetail();
  renderIssues();
  renderCandidates();
  renderChainTab();
  renderLegend();
  syncViewTabs();
  refreshOpenGraph();
}
/* 图弹窗打开时随结构变化重绘（尽量保留坐标） */
function refreshOpenGraph() {
  if ($("#graphModal").classList.contains("hidden")) return;
  const prev = graph.pos;
  buildGraphData();
  graph.pos = new Map([...graph.nodes.map((n) => [n.id, prev.get(n.id)])].filter(([, p]) => p));
  runLayout(false);
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
      ${relatedEvidenceHTML("l:" + l.id)}
      <div class="detail-section detail-actions">
        <button class="btn ghost" id="btnLeafGraph" style="color:#7a4fa3;border-color:#7a4fa3">🕸 证据链关系图</button>
        <button class="btn ghost" id="btnLeafNewEv" style="color:#35609b;border-color:#35609b">＋ 关联新证据</button>
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
    $("#btnLeafGraph")?.addEventListener("click", () => openGraph({ kind: "leaf", id: l.id }));
    $("#btnLeafNewEv")?.addEventListener("click", () => {
      const id = addEvidence({ subjects: ["l:" + l.id], kind: "holes" });
      state.chainEditing = id;
      switchRightTab("chain");
      renderChainTab();
    });
    $("#tab-detail").querySelectorAll("[data-gopair]").forEach((a) =>
      a.onclick = (e) => { e.preventDefault(); state.selection = { kind: "pair", id: a.dataset.gopair }; renderAll(); });
    $("#tab-detail").querySelectorAll("[data-open-ev]").forEach((d) =>
      d.onclick = () => { state.chainEditing = d.dataset.openEv; switchRightTab("chain"); renderChainTab(); });
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
        <button class="btn ghost" id="btnPairGraph" style="color:#7a4fa3;border-color:#7a4fa3">🕸 证据链关系图</button>
        <button class="btn ghost" id="btnPairNewEv" style="color:#35609b;border-color:#35609b">＋ 关联新证据</button>
      </div>
      <div class="detail-section detail-actions">
        <button class="btn ghost" id="btnBreak" style="color:#b3382c;border-color:#b3382c">解除配叶（拆为两单叶）</button>
      </div>
      <p class="muted">所在：${q ? esc(q.name) : "两叶不在同一帖 / 待编"}</p>
      ${relatedEvidenceHTML("p:" + p.id)}
    </div>`;
    $("#tab-detail").querySelectorAll("[data-st]").forEach((b) =>
      b.onclick = () => setStatus("pair", p.id, b.dataset.st));
    $("#pJoin").onchange = (e) => updatePair(p.id, {}, { join: e.target.checked });
    $("#pThread").onchange = (e) => updatePair(p.id, {}, { threadMatch: e.target.checked });
    $("#btnBreak").onclick = () => breakPair(p.id);
    $("#btnPairGraph").onclick = () => openGraph({ kind: "pair", id: p.id });
    $("#btnPairNewEv").onclick = () => {
      const id = addEvidence({ subjects: ["p:" + p.id], kind: "fold" });
      state.chainEditing = id;
      switchRightTab("chain");
      renderChainTab();
    };
    $("#tab-detail").querySelectorAll("[data-go]").forEach((a) =>
      a.onclick = (e) => { e.preventDefault(); state.selection = { kind: "leaf", id: a.dataset.go }; renderAll(); });
    $("#tab-detail").querySelectorAll("[data-open-ev]").forEach((d) =>
      d.onclick = () => { state.chainEditing = d.dataset.openEv; switchRightTab("chain"); renderChainTab(); });
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
        <button class="btn ghost" id="btnQuireGraph" style="color:#7a4fa3;border-color:#7a4fa3">🕸 证据链关系图</button>
        <button class="btn danger" id="doDelQ">删除书帖${q.leaves.length ? "（叶件回待编区）" : ""}</button>
      </div>
      ${relatedEvidenceHTML("q:" + q.id)}</div>`;
    $("#qName").onchange = (e) => { pushUndo("改帖名"); q.name = e.target.value; afterStructural(""); };
    $("#qLock").onchange = (e) => toggleQuireLock(q.id, e.target.checked);
    $("#doSplit").onclick = () => { const v = +$("#splitAt").value; if (v) splitQuire(q.id, v); };
    $("#doMerge")?.addEventListener("click", () => { const v = $("#mergeWith").value; if (v) mergeQuires(q.id, v); });
    $("#doDelQ").onclick = () => deleteQuire(q.id);
    $("#btnQuireGraph").onclick = () => openGraph({ kind: "quire", id: q.id });
    box.querySelectorAll("[data-open-ev]").forEach((d) =>
      d.onclick = () => { state.chainEditing = d.dataset.openEv; switchRightTab("chain"); renderChainTab(); });
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
    ${esc(leafLabel(frag))}：共 ${cands.length} 个不冲突位置，并列保留，不自动定案${
      cands.excluded ? `；已排除 <b style="color:#b3382c">${cands.excluded}</b> 个会新增嵌套/悬空/重号等冲突的落点（如帖首、帖缘）` : ""
    }</div>` +
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
  state.chainEditing = null;
  $("#chainList").classList.remove("hidden");
  $("#chainEditor").classList.add("hidden");
  undoStack.length = redoStack.length = 0;
  state.dirty = false;
  $("#dirtyLine").classList.add("hidden");
  syncUndoButtons();
  state.issues = validate(state.doc);
  renderHypoUI();
  renderAll();
  toast("已载入：" + h.name);
}
function normalize(d) {
  d = d || blankDocument();
  d.leaves ||= []; d.pairs ||= []; d.quires ||= []; d.notes ||= ""; d.title ||= "未命名卷子";
  d.evidences ||= []; d.claims ||= []; d.links ||= [];
  d.leaves.forEach((l) => { l.faces ||= { recto: "", verso: "" }; l.evidence ||= { fold: "none", seam: false, holes: 0 }; l.status ||= "doubt"; });
  d.pairs.forEach((p) => { p.evidence ||= { join: false, threadMatch: false }; p.status ||= "doubt"; });
  d.quires.forEach((q) => { q.locked ||= false; q.leaves ||= []; });
  normalizeChain(d);
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

  /* ④ 证据链增减：记录以 标题|类型|来源 指纹比对，关系以 证据指纹→结论标签 比对 */
  const chainA = chainAnalysis(da), chainB = chainAnalysis(db);
  const evFinger = (d, e) => [e.title, e.kind, e.source || "", e.status].join("|");
  const evMapA = new Map(activeEvidences(da).map((e) => [evFinger(da, e), e]));
  const evMapB = new Map(activeEvidences(db).map((e) => [evFinger(db, e), e]));
  const evAdded = [...evMapB].filter(([f]) => !evMapA.has(f)).map(([, e]) => e);
  const evRemoved = [...evMapA].filter(([f]) => !evMapB.has(f)).map(([, e]) => e);
  const evStatusChanged = [];
  evMapB.forEach((e, f) => {
    const old = evMapA.get(f);
    if (old && old.status !== e.status)
      evStatusChanged.push({ title: e.title, from: EV_STATUS[old.status], to: EV_STATUS[e.status] });
  });
  const linkFinger = (d, an, lk) => {
    const ev = evidenceById(lk.evidence, d);
    const cl = an.claimsById.get(lk.target);
    return (ev ? evFinger(d, ev) : "?") + " " + STANCE_LABEL[lk.stance] + " " + (cl ? cl.label : chainTargetLabel(d, lk.target));
  };
  const lkA = new Set(da.links.map((l) => linkFinger(da, chainA, l)));
  const lkB = new Set(db.links.map((l) => linkFinger(db, chainB, l)));
  const lkAdded = [...lkB].filter((x) => !lkA.has(x));
  const lkRemoved = [...lkA].filter((x) => !lkB.has(x));
  const cfA = chainConflictCount(da, chainA), cfB = chainConflictCount(db, chainB);

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
      <table class="cmp-table"><tr><th>类型</th><th>A</th><th>B</th></tr>${conflictRows}</table></div>
    <div class="cmp-section"><h3>④ 证据链增减</h3>
      <div class="cmp-cols">
        <div class="cmp-col"><h4>新增证据记录（${evAdded.length}）</h4>
          <ul>${evAdded.length ? evAdded.map((e) => `<li class="diff-add">${esc(e.title)}
            <small class="muted">[${EV_TYPES[e.kind]?.name || "其他"} · ${CRED_LABEL[e.credibility]} · ${EV_STATUS[e.status]}]</small></li>`).join("")
            : "<li>无</li>"}</ul>
          <h4>新增结论关系（${lkAdded.length}）</h4>
          <ul>${lkAdded.length ? lkAdded.map((x) => `<li class="diff-add">${esc(x)}</li>`).join("") : "<li>无</li>"}</ul>
        </div>
        <div class="cmp-col"><h4>移除证据记录（${evRemoved.length}）</h4>
          <ul>${evRemoved.length ? evRemoved.map((e) => `<li class="diff-del">${esc(e.title)}</li>`).join("") : "<li>无</li>"}</ul>
          <h4>移除结论关系（${lkRemoved.length}）</h4>
          <ul>${lkRemoved.length ? lkRemoved.map((x) => `<li class="diff-del">${esc(x)}</li>`).join("") : "<li>无</li>"}</ul>
        </div>
      </div>
      ${evStatusChanged.length ? `<p class="muted" style="margin-top:6px">状态变化：
        ${evStatusChanged.map((x) => esc(x.title) + "（" + x.from + "→" + x.to + "）").join("；")}</p>` : ""}
      <table class="cmp-table" style="margin-top:8px"><tr><th>证据链冲突</th><th>A</th><th>B</th></tr>
        ${["mutex", "dangling-target", "dangling-basis", "self", "cycle"].map((k) =>
          `<tr><td>${({ mutex: "同证支持互斥结论", "dangling-target": "引用已删除对象", "dangling-basis": "依据缺失", self: "自我证明", cycle: "循环依赖" })[k]}</td>
          <td ${cfA[k] > cfB[k] ? 'class="diff-add"' : ""}>${cfA[k]}</td>
          <td ${cfB[k] > cfA[k] ? 'class="diff-add"' : ""}>${cfB[k]}</td></tr>`).join("")}
      </table>
    </div>`;
}
function chainConflictCount(doc, an) {
  const c = { mutex: 0, "dangling-target": 0, "dangling-basis": 0, self: 0, cycle: 0 };
  an.flags.ev.forEach((fl) => fl.forEach((f) => { if (f.kind in c) c[f.kind]++; }));
  an.flags.link.forEach((fl) => fl.forEach((f) => { if (f.kind === "dangling-target") c["dangling-target"]++; }));
  return c;
}
function countChainFlags(an) {
  let n = 0;
  an.flags.ev.forEach((fl) => { n += new Set(fl.map((f) => f.msg)).size; });
  an.flags.link.forEach((fl) => { n += fl.filter((f) => f.kind === "dangling-ev" || f.kind === "dangling-target").length; });
  return n;
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
      state.chainEditing = null;
      $("#chainList").classList.remove("hidden");
      $("#chainEditor").classList.add("hidden");
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

  // 证据链清单（版本、来源、可信度、状态、冲突均保留）
  const an = state.chainAnalysis;
  const evRows = activeEvidences(state.doc).map((ev) => {
    const fl = an.flags.ev.get(ev.id) || [];
    const links = state.doc.links.filter((l) => l.evidence === ev.id).map((lk) => {
      const cl = an.claimsById.get(lk.target);
      return (lk.stance === "support" ? "支：" : "驳：") + (cl ? cl.label : chainTargetLabel(state.doc, lk.target));
    });
    const subj = (ev.subjects || []).map((s) => {
      if (s.startsWith("l:")) { const l = leafById(s.slice(2)); return l ? leafLabel(l) : "已删叶"; }
      if (s.startsWith("p:")) return "双叶" + sid(s.slice(2));
      if (s.startsWith("q:")) { const q = quireById(s.slice(2)); return q ? "帖「" + q.name + "」" : "已删帖"; }
      return s;
    });
    return `<tr class="${fl.length ? "ev-conflict" : ""}">
      <td>${esc(ev.title)}</td>
      <td>${EV_TYPES[ev.kind]?.name || "其他"}</td>
      <td>${esc(subj.join("、")) || "—"}</td>
      <td>${esc(ev.source || "")}</td>
      <td>${CRED_LABEL[ev.credibility]}</td>
      <td>${ev.status === "confirmed" ? "已确认" : '<span class="doubt-tag">待核验</span>'}</td>
      <td>v${(ev.history?.length || 0) + 1}${ev.basis?.length ? "<br>依据" + ev.basis.length : ""}</td>
      <td>${esc(links.join("；")) || "—"}</td>
      <td>${fl.length ? [...new Set(fl.map((f) => f.msg))].map((m) => '<span class="doubt-tag">' + esc(m) + "</span>").join("<br>") : ""}</td>
    </tr>`;
  }).join("");
  const candidateRows = state.doc.claims.map((c0) => {
    const decorated = an.claimsById.get(c0.id);
    const nlink = state.doc.links.filter((l) => l.target === c0.id).length;
    return `<tr class="${decorated?.exists === false ? "ev-conflict" : ""}">
      <td>${CLAIM_KIND_LABEL[c0.kind]}</td><td>${esc(decorated?.label || c0.text || "")}</td>
      <td>${nlink}</td><td>${esc(c0.note || "")}</td></tr>`;
  }).join("");

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
      <div class="print-quire" style="page-break-before:always">
        <h3>证据链记录（独立装订证据 · 含版本与来源）</h3>
        ${state.doc.evidences?.length ? `<table class="print-table">
          <tr><th>证据</th><th>类型</th><th>关联对象</th><th>来源说明</th><th>可信度</th><th>状态</th><th>版本</th><th>支持 / 反驳的结论</th><th>冲突标记</th></tr>
          ${evRows}
        </table>` : "<p>无独立证据记录。</p>"}
        ${state.doc.claims?.length ? `<h3 style="margin-top:10px">候选结论（现结构之外另立的复原意见）</h3>
        <table class="print-table"><tr><th>类型</th><th>结论</th><th>引用证据数</th><th>说明</th></tr>${candidateRows}</table>` : ""}
        <p class="print-note">说明：证据链冲突仅标记、不改动复原结构；「已删除对象」指证据引用的叶片/双叶已不在本假设中，记录本身保留备查。
          证据 ${activeEvidences(state.doc).length} 条 · 结论关系 ${state.doc.links.length} 条 ·
          冲突标记 ${countChainFlags(an)} 项。</p>
      </div>
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveCurrent(false); }
});
/* 顶栏按钮与快捷键执行同一对函数 */
$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);
syncUndoButtons();

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

  // ---- 假设 B 在证据链构建完成后再克隆（见函数末） ----

  // ---- 证据链记录（独立于叶件/双叶对象） ----
  const now = new Date().toISOString();
  const ev = (title, kind, subjects, extra = {}) => ({
    id: uid("e"), title, kind, subjects,
    detail: extra.detail || "", source: extra.source || "",
    credibility: extra.credibility || "medium",
    status: extra.status || "pending",
    basis: extra.basis || [], archived: false, mergedInto: null,
    history: extra.history || [], created_at: now,
  });
  const lk = (evidence, target, stance = "support") => ({ id: uid("lk"), evidence, target, stance, created_at: now });
  // 系统结论合成 ID 与 buildClaims 保持一致
  const sysPair = (pairObj) => "~pair:" + pairObj.id;
  const sysPlace = (qObj, lid) => "~place:" + qObj.id + ":" + lid;
  const sysOrder = (a, b) => "~order:" + a + ":" + b;
  const qA = docA.quires[0], qB = docA.quires[1], qC = docA.quires[2];
  const p12 = docA.pairs[0], p45 = docA.pairs[1];

  const evHoles = ev("首帖外叶三针等距，针脚相合", "holes",
    ["l:" + q1leaves[0].id, "l:" + q1leaves[4].id],
    { source: "目验 2026-09-02；修复档案 甲-07", credibility: "high", status: "confirmed",
      detail: "距书脊 8mm，三孔间距均 42mm，两叶完全相合。" });
  const evFold = ev("一二叶中缝外折痕连续，纸纤维过折不断", "fold",
    ["p:" + p12.id],
    { source: "透光观察", credibility: "high", status: "confirmed" });
  const evFolio = ev("叶码一、二笔迹墨色一致，刻工同版", "folio",
    ["l:" + q1leaves[0].id, "l:" + q1leaves[1].id],
    { source: "版片比对", credibility: "medium" });
  // 同证支持互斥：该证据同时支持现状配叶（十三⌒十五）与候选正确配叶（十三⌒十六）
  const evCross = ev("十三叶折痕走向与十六叶疑似相合", "fold",
    ["l:" + q3leaves[0].id, "l:" + q3leaves[2].id, "l:" + q3leaves[3].id],
    { source: "初步目验，待放大复核", credibility: "low",
      detail: "纸面霉损严重，折痕仅隐约可见。" });
  // 引用已删除对象：一条指向已删双叶的结论（ghost），一条指向已删叶的层位结论
  const evGhost = ev("托裱留痕显示原双叶在重装时被拆开", "seam", [],
    { source: "旧修复记录 1958 年", credibility: "medium" });
  // 自我证明
  const evSelf = ev("据纸张帘纹推断中缝单叶成立（以本记录自身为依据）", "paper",
    ["l:" + q2leaves[2].id],
    { source: "整理者推断", credibility: "low", basis: null });
  // 循环依赖：纸纹 → 帘纹宽度 → 纸纹
  const evPaperA = ev("残片纸帘纹宽 1.8cm 与三帖用纸相合", "paper",
    ["l:" + fragA.id], { source: "纤维测量", credibility: "medium" });
  const evPaperB = ev("三帖用纸帘纹宽 1.8cm（由残片样本推定）", "paper",
    ["q:" + qC.id], { source: "纤维测量", credibility: "medium" });
  // 正常的推导依据链：叶码连续（推导）→ 版本留痕
  const evCont = ev("叶码七至八连续无缺", "folio",
    ["l:" + q2leaves[0].id, "l:" + q2leaves[1].id],
    { source: "叶码通读", credibility: "high", status: "confirmed" });
  const evContV = ev("（旧记）七、八间疑有衬纸", "other", [],
    { source: "初校批注", credibility: "low", archived: false, mergedInto: null });

  // 候选结论：十三⌒十六（正确嵌套的另立意见）；残片应置第三帖第 3 位
  const claimCorrectPair = {
    id: uid("c"), kind: "pair", a: q3leaves[0].id, b: q3leaves[3].id,
    label: "", note: "与现状交叉配对互斥", created_at: now,
  };
  const claimFragPlace = {
    id: uid("c"), kind: "place", leaf: fragA.id, qid: qC.id, pos: 2,
    label: "", note: "五叶奇数帖，残片居中缝", created_at: now,
  };

  docA.evidences = [evHoles, evFold, evFolio, evCross, evGhost, evSelf, evPaperA, evPaperB, evCont, evContV];
  docA.claims = [claimCorrectPair, claimFragPlace];
  docA.links = [
    lk(evHoles.id, sysPair(p12)),
    lk(evFold.id, sysPair(p12)),
    lk(evFolio.id, sysOrder(q1leaves[0].id, q1leaves[1].id)),
    lk(evCont.id, sysOrder(q2leaves[0].id, q2leaves[1].id)),
    // 互斥：同一低可信证据既支持现状配叶十三⌒十五，又支持候选十三⌒十六
    lk(evCross.id, "~pair:" + docA.pairs.find((p) => p.a === q3leaves[0].id && p.b === q3leaves[2].id).id),
    lk(evCross.id, claimCorrectPair.id),
    // 同时反驳另一条现状配叶十四⌒十六
    lk(evCross.id, "~pair:" + docA.pairs.find((p) => p.a === q3leaves[1].id).id, "refute"),
    // 残片证据支持候选层位与现状中缝层位（九）两种意见——层位互斥
    lk(evPaperA.id, claimFragPlace.id),
    lk(evPaperA.id, sysPlace(qB, q2leaves[2].id), "refute"),
    // 悬空：引用不存在的结论 ID（模拟对象删除后只标记）
    lk(evGhost.id, "~pair:deleted000000"),
  ];
  // 自我证明 + 循环
  evSelf.basis = [evSelf.id];
  evPaperA.basis = [evPaperB.id];
  evPaperB.basis = [evPaperA.id];
  // 版本历史示例
  evHoles.history.push({
    at: now, note: "初记为两孔，复核后更正为三针",
    title: evHoles.title, kind: "holes", subjects: clone(evHoles.subjects),
    detail: evHoles.detail, source: evHoles.source, credibility: "medium", status: "pending",
  });
  // 一条已合并归档的重复记录
  const evMerged = ev("（重复）首帖针脚测量记录", "holes", ["l:" + q1leaves[0].id],
    { source: "目验 2026-09-01" });
  evMerged.archived = true; evMerged.mergedInto = evHoles.id;
  docA.evidences.push(evMerged);

  // ---- 假设 B：残片嵌入第三帖中缝，并改配为正确嵌套（克隆已含证据链的 docA） ----
  const docB = clone(docA);
  const fb = docB.leaves.find((l) => l.frag);
  const q3b = docB.quires[2];
  q3b.leaves.splice(2, 0, fb.id);                 // 五叶奇数帖，残片居中
  docB.pairs = docB.pairs.filter((p) => {
    const inQ3 = q3leaves.some((l) => l.id === p.a);
    return !inQ3;
  });
  const b13 = q3leaves[0].id, b14 = q3leaves[1].id, b15 = q3leaves[2].id, b16 = q3leaves[3].id;
  const newPairB1 = { id: uid("p"), a: b13, b: b16, status: "doubt", evidence: { join: false, threadMatch: true } };
  const newPairB2 = { id: uid("p"), a: b14, b: b15, status: "doubt", evidence: { join: false, threadMatch: true } };
  docB.pairs.push(newPairB1, newPairB2);
  docB.notes = "尝试方案：残片置于第三帖中缝，十三⌒十六、十四⌒十五 正确嵌套（证据仍不足，保持存疑）。";

  // 证据链随结构变化：候选层位被现结构采纳 → 移除候选、关系改指新系统结论；
  // 交叉配叶拆除后互斥解除；原「反驳十四⌒十六」关系因对象已删成为悬空标记（不改动，留作追溯）；
  // 另有一条指向不存在结论的关系始终为悬空，供对照。
  docB.claims = docB.claims.filter((c) => c.id !== claimFragPlace.id);
  docB.links = docB.links.filter((l) =>
    !(l.evidence === evPaperA.id && l.target === claimFragPlace.id));
  docB.links.push(lk(evPaperA.id, "~place:" + qC.id + ":" + fragA.id));
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

"use strict";

// ===== State =====
const STORAGE_KEY = "cap_quiz_v1";
const ALL = "all";

let QUESTIONS = [];
let TRANSLATIONS = {};       // id -> {question_zh, options_zh, passage_zh}
let EXPLANATIONS_ZH = {};    // id -> {explanation_zh}

const YEARS = [115, 114, 113, 112, 111];
const SUBJECTS = [
  { key: "chinese", label: "國文" },
  { key: "english", label: "英文" },
  { key: "math",    label: "數學" },
  { key: "social",  label: "社會" },
  { key: "science", label: "自然" },
];
const SUBJ_MAP = Object.fromEntries(SUBJECTS.map(s => [s.key, s.label]));

let selectedYear = "115";    // "115" | "114" | "113" | "112" | "111" | "all"
let selectedSubject = "chinese"; // "chinese" | "english" | "math" | "social" | "science" | "all"

let session = null;
let lastResult = null;
let randomCount = 10;
let lastSearchMatches = [];

// ===== Official CAP Grade Cutoffs (115-111) =====
// For chinese / social / science: minimum correct count for [A++, A+, A, B++, B+, B]
// For english / math: minimum 100-pt weighted score for [A++, A+, A, B++, B+, B]
const GRADE_LABELS = ["A++", "A+", "A", "B++", "B+", "B", "C"];
const CAP_CUTOFFS = {
  115: {
    chinese: [40, 39, 36, 32, 28, 17],
    social:  [52, 51, 48, 41, 34, 20],
    science: [47, 46, 43, 36, 29, 19],
    english: [98.14, 96.28, 90.70, 82.30, 69.28, 38.43],
    math:    [91.60, 85.70, 77.10, 68.70, 54.60, 36.00],
  },
  114: {
    chinese: [40, 38, 36, 32, 28, 18],
    social:  [52, 51, 48, 41, 35, 21],
    science: [48, 46, 43, 36, 29, 18],
    english: [98.14, 95.33, 90.70, 83.21, 71.05, 38.43],
    math:    [93.20, 85.70, 76.20, 67.10, 59.40, 40.60],
  },
  113: {
    chinese: [40, 39, 37, 33, 30, 18],
    social:  [52, 50, 48, 42, 36, 21],
    science: [48, 47, 44, 37, 30, 19],
    english: [98.14, 96.23, 90.70, 82.30, 70.01, 38.43],
    math:    [93.20, 86.40, 76.40, 66.20, 56.90, 38.10],
  },
  112: {
    chinese: [40, 38, 36, 32, 28, 18],
    social:  [51, 50, 47, 41, 34, 21],
    science: [48, 47, 44, 37, 30, 19],
    english: [98.14, 96.23, 90.70, 82.26, 69.01, 38.43],
    math:    [91.60, 85.70, 76.20, 66.20, 56.90, 38.80],
  },
  111: {
    chinese: [40, 38, 36, 32, 27, 18],
    social:  [52, 50, 48, 41, 33, 21],
    science: [47, 45, 42, 36, 28, 18],
    english: [96.28, 93.47, 88.84, 80.44, 69.15, 38.43],
    math:    [96.60, 87.80, 80.50, 69.00, 56.00, 37.00],
  },
};

function computeCapGrade(year, subject, correct, total) {
  const y = Number(year);
  if (!CAP_CUTOFFS[y] || !CAP_CUTOFFS[y][subject]) return null;
  const expectedTotal = QUESTIONS.filter(q => q.year === y && q.subject === subject).length;
  if (!expectedTotal || total !== expectedTotal) return null;

  const cuts = CAP_CUTOFFS[y][subject];
  const isWeighted = (subject === "english" || subject === "math");
  const metric = isWeighted ? (correct / total) * 100 : correct;

  let grade = "C";
  for (let i = 0; i < cuts.length; i++) {
    if (metric >= cuts[i]) { grade = GRADE_LABELS[i]; break; }
  }
  const tier = grade.startsWith("A") ? "精熟" : (grade.startsWith("B") ? "基礎" : "待加強");
  const cls = grade.startsWith("A") ? "grade-a" : (grade.startsWith("B") ? "grade-b" : "grade-c");
  const note = isWeighted
    ? `${y} 年${SUBJ_MAP[subject]}參考等級（僅以選擇題正確率估算）`
    : `${y} 年${SUBJ_MAP[subject]}官方等級對照（${tier}）`;
  return { grade, tier, cls, note };
}

// ===== Storage =====
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    if (!Array.isArray(s.sessions)) s.sessions = [];
    if (!Array.isArray(s.wrongIdsAggregate)) s.wrongIdsAggregate = [];
    if (!s.notes || typeof s.notes !== "object") s.notes = {};
    if (s.pausedSession === undefined) s.pausedSession = null;
    return s;
  } catch {
    return { sessions: [], wrongIdsAggregate: [], notes: {}, pausedSession: null };
  }
}
function saveStore(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
function saveNote(qid, text) {
  const store = loadStore();
  const v = (text || "").trim();
  if (v) store.notes[qid] = v;
  else delete store.notes[qid];
  saveStore(store);
}

// ===== View routing =====
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "home") renderResumeBlock();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ===== Boot =====
async function boot() {
  const statusBar = document.getElementById("status-bar");
  try {
    const [qResp, tResp, eResp] = await Promise.all([
      fetch("data/questions.json"),
      fetch("data/translations.json").catch(() => null),
      fetch("data/explanations_zh.json").catch(() => null),
    ]);
    if (!qResp.ok) throw new Error(`questions.json HTTP ${qResp.status}`);
    QUESTIONS = await qResp.json();

    if (tResp && tResp.ok) TRANSLATIONS = await tResp.json();
    if (eResp && eResp.ok) EXPLANATIONS_ZH = await eResp.json();

    const expCount = Object.keys(EXPLANATIONS_ZH).length;
    const tCount = Object.keys(TRANSLATIONS).length;
    statusBar.textContent = `115–111 年國中教育會考題庫共 ${QUESTIONS.length} 題（5 年度 × 5 科選擇題，附原卷截圖），已載入繁中詳解 ${expCount} 題、英文科翻譯 ${tCount} 題。`;
    statusBar.classList.add("ok");

    renderSubjectGrid();
  } catch (e) {
    statusBar.textContent = `題庫載入失敗：${e.message}（請用 HTTP server 啟動，例：dotnet run --project src/CapQuiz）`;
    return;
  }
  refreshWrongCount();
  renderResumeBlock();
  attachHomeHandlers();
  attachQuizHandlers();
  attachResultHandlers();
  attachHistoryHandlers();
  attachSearchHandlers();
  attachNav();
  attachNavGuard();
  showView("home");
}

function attachNavGuard() {
  window.addEventListener("popstate", () => {
    if (!session) return;
    if (confirm("要離開測驗嗎？這次作答將不會儲存。")) {
      session = null;
      showView("home");
    } else {
      try { history.pushState({ capQuiz: 1 }, ""); } catch {}
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (session) { e.preventDefault(); e.returnValue = ""; }
  });
}

// ===== Home: Year Tabs & Subject Grid =====
function currentPool() {
  return QUESTIONS.filter(q => {
    const yOk = selectedYear === ALL || String(q.year) === selectedYear;
    const sOk = selectedSubject === ALL || q.subject === selectedSubject;
    return yOk && sOk;
  });
}

function scopeLabel(year, subject) {
  const yTxt = year === ALL ? "全部年度" : `${year} 年`;
  const sTxt = subject === ALL ? "全部考科" : (SUBJ_MAP[subject] || subject);
  return `${yTxt} · ${sTxt}`;
}

function renderSubjectGrid() {
  const grid = document.getElementById("subject-grid");
  grid.innerHTML = "";
  const yearPool = selectedYear === ALL
    ? QUESTIONS
    : QUESTIONS.filter(q => String(q.year) === selectedYear);

  const items = [
    ...SUBJECTS.map(s => ({
      key: s.key,
      label: s.label,
      count: yearPool.filter(q => q.subject === s.key).length,
    })),
    {
      key: ALL,
      label: selectedYear === ALL ? "全部五科" : `${selectedYear} 全部`,
      count: yearPool.length,
    },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "subj-card" + (selectedSubject === item.key ? " active" : "");
    btn.dataset.subject = item.key;
    btn.innerHTML = `<span class="subj-name">${escapeHtml(item.label)}</span><span class="subj-count">${item.count} 題</span>`;
    btn.addEventListener("click", () => {
      selectedSubject = item.key;
      renderSubjectGrid();
    });
    grid.appendChild(btn);
  }
  applySourceRange();
}

function applySourceRange() {
  const n = currentPool().length;
  const start = document.getElementById("seq-start");
  const end = document.getElementById("seq-end");
  start.max = Math.max(1, n);
  end.max = Math.max(1, n);
  start.value = 1;
  end.value = Math.max(1, n);
  document.getElementById("seq-hint").textContent =
    `目前選擇「${scopeLabel(selectedYear, selectedSubject)}」（共 ${n} 題）。完成單一年度單科全卷將自動估算會考等級。`;
}

function refreshWrongCount() {
  const store = loadStore();
  const n = (store.wrongIdsAggregate || []).length;
  document.getElementById("wrong-count").textContent = `目前累計 ${n} 題`;
  document.getElementById("start-wrong").disabled = n === 0;
}

function attachNav() {
  document.querySelectorAll(".navbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      if (v === "history") renderHistory();
      showView(v);
      if (v === "search") document.getElementById("search-input").focus();
    });
  });
}

function attachHomeHandlers() {
  document.querySelectorAll(".year-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".year-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      selectedYear = tab.dataset.year;
      renderSubjectGrid();
    });
  });
  document.querySelectorAll(".count-chip").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".count-chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      randomCount = parseInt(b.dataset.count, 10);
    });
  });
  document.getElementById("start-sequential").addEventListener("click", startSequential);
  document.getElementById("start-random").addEventListener("click", startRandom);
  document.getElementById("start-wrong").addEventListener("click", startWrongOnly);
  document.getElementById("resume-quiz").addEventListener("click", resumeQuiz);
  document.getElementById("resume-discard").addEventListener("click", () => {
    if (!confirm("確定放棄暫停中的測驗嗎？")) return;
    const store = loadStore();
    store.pausedSession = null;
    saveStore(store);
    renderResumeBlock();
  });
}

function getFeedbackMode() {
  return document.querySelector("input[name=feedback]:checked").value;
}

function readRange() {
  const pool = currentPool();
  const start = parseInt(document.getElementById("seq-start").value, 10);
  const end = parseInt(document.getElementById("seq-end").value, 10);
  if (!(start >= 1 && end >= start && end <= pool.length)) {
    alert(`請輸入 1 ~ ${pool.length} 之間且起 ≤ 迄的範圍`);
    return null;
  }
  return { pool, start, end };
}

function startSequential() {
  const r = readRange();
  if (!r) return;
  const ids = r.pool.slice(r.start - 1, r.end).map(q => q.id);
  beginSession({
    mode: "sequential", ids, rangeStart: r.start, rangeEnd: r.end,
    year: selectedYear, subject: selectedSubject,
  });
}

function startRandom() {
  const r = readRange();
  if (!r) return;
  const slice = r.pool.slice(r.start - 1, r.end);
  const n = Math.min(randomCount, slice.length);
  if (n === 0) { alert("指定的範圍內沒有題目。"); return; }
  for (let i = slice.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slice[i], slice[j]] = [slice[j], slice[i]];
  }
  const ids = slice.slice(0, n).map(q => q.id);
  beginSession({
    mode: "random", ids, rangeStart: r.start, rangeEnd: r.end,
    year: selectedYear, subject: selectedSubject,
  });
}

function startWrongOnly() {
  const store = loadStore();
  const ids = [...(store.wrongIdsAggregate || [])];
  if (!ids.length) return;
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  beginSession({ mode: "wrong-only", ids, year: ALL, subject: ALL });
}

// ===== Quiz =====
function beginSession({ mode, ids, rangeStart = null, rangeEnd = null, year = ALL, subject = ALL }) {
  if (!ids.length) { alert("沒有題目可測驗。"); return; }
  session = {
    mode, rangeStart, rangeEnd, ids, year, subject,
    idx: 0,
    answers: {},
    locked: new Set(),
    feedbackMode: getFeedbackMode(),
    startedAt: Date.now(),
    showExplain: false,
  };
  const store = loadStore();
  if (store.pausedSession) { store.pausedSession = null; saveStore(store); }
  showView("quiz");
  try { history.pushState({ capQuiz: 1 }, ""); } catch {}
  renderQuestion();
}

function pauseQuiz() {
  if (!session) return;
  const store = loadStore();
  store.pausedSession = {
    mode: session.mode, rangeStart: session.rangeStart, rangeEnd: session.rangeEnd,
    ids: session.ids, year: session.year, subject: session.subject,
    idx: session.idx, answers: session.answers,
    locked: [...session.locked], feedbackMode: session.feedbackMode,
    elapsedMs: Date.now() - session.startedAt,
    savedAt: Date.now(),
  };
  saveStore(store);
  session = null;
  renderResumeBlock();
  showView("home");
}

function resumeQuiz() {
  const store = loadStore();
  const p = store.pausedSession;
  if (!p) return;
  session = {
    mode: p.mode, rangeStart: p.rangeStart, rangeEnd: p.rangeEnd,
    ids: p.ids, year: p.year || ALL, subject: p.subject || ALL,
    idx: p.idx || 0, answers: p.answers || {},
    locked: new Set(p.locked || []), feedbackMode: p.feedbackMode,
    startedAt: Date.now() - (p.elapsedMs || 0),
    showExplain: false,
  };
  store.pausedSession = null;
  saveStore(store);
  showView("quiz");
  try { history.pushState({ capQuiz: 1 }, ""); } catch {}
  renderQuestion();
}

function renderResumeBlock() {
  const p = loadStore().pausedSession;
  const block = document.getElementById("resume-block");
  if (!p) { block.hidden = true; return; }
  block.hidden = false;
  const lbl = scopeLabel(p.year || ALL, p.subject || ALL);
  const answered = Object.keys(p.answers || {}).filter(k => Boolean(p.answers[k])).length;
  document.getElementById("resume-info").textContent =
    `${lbl}　·　共 ${p.ids.length} 題，進度第 ${(p.idx || 0) + 1} 題、已作答 ${answered} 題　·　${formatDate(p.savedAt)} 暫停`;
}

function currentQ() {
  return QUESTIONS.find(q => q.id === session.ids[session.idx]);
}

function qLabel(q) {
  return `${q.year} ${SUBJ_MAP[q.subject] || q.subject} #${q.srcNo}`;
}

function renderQuestion() {
  const q = currentQ();

  document.getElementById("q-no").textContent =
    `${qLabel(q)}（第 ${session.idx + 1} / ${session.ids.length} 題）`;

  const cat = document.getElementById("q-cat");
  if (q.category) { cat.textContent = q.category; cat.hidden = false; }
  else cat.hidden = true;

  // Group passage
  const pBox = document.getElementById("q-passage-box");
  const pBody = document.getElementById("q-passage");
  const pImgWrap = document.getElementById("q-passage-img-wrap");
  const pImg = document.getElementById("q-passage-img");
  if (q.passage || q.passageImage) {
    pBody.textContent = q.passage || "";
    if (q.passageImage) {
      pImg.src = q.passageImage;
      pImgWrap.hidden = false;
    } else {
      pImgWrap.hidden = true;
    }
    pBox.hidden = false;
    pBox.open = true;
  } else {
    pBox.hidden = true;
  }

  document.getElementById("q-stem").textContent = q.question;

  // Original cropped image
  const imgBox = document.getElementById("q-image-box");
  const imgEl = document.getElementById("q-image");
  if (q.image) {
    imgEl.src = q.image;
    imgBox.hidden = false;
    const hasGraphicPlaceholder = Object.values(q.options || {}).some(v => String(v).includes("請見原卷截圖"));
    const mentionsFig = /如圖|下圖|附圖|右圖|左圖|表[（(]|picture/i.test(q.question);
    imgBox.open = hasGraphicPlaceholder || mentionsFig || q.subject === "math";
  } else {
    imgBox.hidden = true;
    imgBox.open = false;
  }

  // Options (single choice)
  const ul = document.getElementById("q-options");
  ul.innerHTML = "";
  for (const letter of Object.keys(q.options)) {
    const li = document.createElement("li");
    li.dataset.letter = letter;
    li.innerHTML = `<span class="opt-letter">(${letter})</span><span class="opt-text">${escapeHtml(q.options[letter])}</span>`;
    li.addEventListener("click", () => pickOption(letter));
    ul.appendChild(li);
  }

  applyOptionState();
  renderTranslation(q);
  renderNote(q);

  // Explanation
  const box = document.getElementById("q-explain");
  if (session.showExplain) {
    box.innerHTML = explanationHtml(q);
    box.hidden = false;
  } else {
    box.hidden = true;
  }

  // Progress bar
  const pct = ((session.idx + 1) / session.ids.length) * 100;
  document.getElementById("quiz-progress-bar").style.width = `${pct}%`;
  document.getElementById("quiz-progress-text").textContent = `第 ${session.idx + 1} / ${session.ids.length} 題`;

  // Buttons
  document.getElementById("btn-prev").disabled = session.idx === 0;
  const isLast = session.idx === session.ids.length - 1;
  document.getElementById("btn-next").hidden = isLast;
  const submitBtn = document.getElementById("btn-submit");
  submitBtn.hidden = !isLast;
  submitBtn.textContent = session.feedbackMode === "submit" ? "交卷" : "完成";
  document.getElementById("btn-explain").textContent = session.showExplain ? "隱藏詳解" : "詳解";
}

function renderTranslation(q) {
  const box = document.getElementById("q-translate");
  const tr = TRANSLATIONS[q.id];
  if (!tr) { box.hidden = true; box.open = false; return; }

  box.hidden = false;
  box.open = false;
  let stemText = "";
  if (tr.passage_zh) stemText += `【題組引文翻譯】\n${tr.passage_zh}\n\n`;
  if (tr.question_zh) stemText += tr.question_zh;
  document.getElementById("qt-stem").textContent = stemText.trim();

  const ul = document.getElementById("qt-options");
  ul.innerHTML = "";
  for (const letter of Object.keys(q.options || {})) {
    const zh = tr.options_zh ? tr.options_zh[letter] : null;
    if (zh == null) continue;
    const li = document.createElement("li");
    li.innerHTML = `<span class="opt-letter">(${letter})</span><span class="opt-text">${escapeHtml(zh)}</span>`;
    ul.appendChild(li);
  }
}

function renderNote(q) {
  const ta = document.getElementById("q-note");
  const status = document.getElementById("q-note-status");
  ta.value = loadStore().notes[q.id] || "";
  status.textContent = "";
  if (ta._noteTimer) clearTimeout(ta._noteTimer);
  ta.oninput = () => {
    clearTimeout(ta._noteTimer);
    ta._noteTimer = setTimeout(() => {
      saveNote(q.id, ta.value);
      status.textContent = "已儲存";
      setTimeout(() => { status.textContent = ""; }, 1500);
    }, 400);
  };
}

function explanationHtml(q) {
  const ansText = q.answer.length === 4 ? "本題送分（A/B/C/D 皆給分）" : q.answer.join(", ");
  const ans = `<div class="explain-ans">官方正解：<b>${ansText}</b></div>`;
  const zh = EXPLANATIONS_ZH[q.id]?.explanation_zh;
  if (zh) return ans + `<div class="explain-body">${escapeHtml(zh)}</div>`;
  return ans + `<div class="explain-body muted">本題暫無文字詳解，僅提供官方正解。</div>`;
}

function applyOptionState() {
  const q = currentQ();
  const locked = session.locked.has(q.id);
  const picked = session.answers[q.id] || "";
  const correctSet = new Set(q.answer);
  const fb = document.getElementById("q-feedback");

  document.querySelectorAll("#q-options li").forEach(li => {
    li.classList.remove("selected", "correct", "wrong", "locked");
    if (locked) li.classList.add("locked");
    const letter = li.dataset.letter;
    if (locked) {
      if (correctSet.has(letter)) li.classList.add("correct");
      if (picked === letter && !correctSet.has(letter)) li.classList.add("wrong");
    } else if (picked === letter) {
      li.classList.add("selected");
    }
  });

  if (locked) {
    const ok = Boolean(picked && correctSet.has(picked));
    fb.classList.remove("correct", "wrong");
    if (ok) {
      fb.classList.add("correct");
      fb.textContent = `✓ 答對！（正解：${q.answer.join(", ")}）`;
    } else {
      fb.classList.add("wrong");
      fb.textContent = `✗ 答錯。你選了 ${picked || "(未作答)"}，正解：${q.answer.join(", ")}`;
    }
    fb.hidden = false;
  } else {
    fb.hidden = true;
  }
}

function pickOption(letter) {
  const q = currentQ();
  if (session.locked.has(q.id)) return;
  session.answers[q.id] = letter;
  if (session.feedbackMode === "immediate") session.locked.add(q.id);
  applyOptionState();
}

function attachQuizHandlers() {
  document.getElementById("btn-prev").addEventListener("click", () => {
    if (session.idx > 0) { session.idx--; session.showExplain = false; renderQuestion(); }
  });
  document.getElementById("btn-next").addEventListener("click", () => {
    if (session.idx < session.ids.length - 1) { session.idx++; session.showExplain = false; renderQuestion(); }
  });
  document.getElementById("btn-submit").addEventListener("click", finishQuiz);
  document.getElementById("btn-explain").addEventListener("click", () => {
    session.showExplain = !session.showExplain;
    renderQuestion();
  });
  document.getElementById("quiz-pause").addEventListener("click", pauseQuiz);
  document.getElementById("quiz-quit").addEventListener("click", () => {
    if (confirm("離開將不會儲存這次測驗結果（如需保留進度請按「暫停」）。確定離開？")) {
      session = null; showView("home");
    }
  });
}

function finishQuiz() {
  const wrongIds = [];
  let correctCount = 0;

  for (const qid of session.ids) {
    const q = QUESTIONS.find(x => x.id === qid);
    if (!q) continue;
    const picked = session.answers[qid] || "";
    const ok = Boolean(picked && q.answer.includes(picked));
    if (ok) correctCount++;
    else wrongIds.push(qid);
  }

  const gradeInfo = (session.year !== ALL && session.subject !== ALL)
    ? computeCapGrade(session.year, session.subject, correctCount, session.ids.length)
    : null;

  const result = {
    id: new Date().toISOString(),
    date: new Date().toISOString(),
    mode: session.mode,
    year: session.year,
    subject: session.subject,
    count: session.ids.length,
    rangeStart: session.rangeStart,
    rangeEnd: session.rangeEnd,
    feedbackMode: session.feedbackMode,
    score: correctCount,
    grade: gradeInfo ? gradeInfo.grade : null,
    wrongIds,
    answers: { ...session.answers },
    ids: [...session.ids],
    durationMs: Date.now() - session.startedAt,
  };

  const store = loadStore();
  store.sessions.unshift(result);
  store.pausedSession = null;
  const agg = new Set(store.wrongIdsAggregate || []);
  for (const w of wrongIds) agg.add(w);
  for (const qid of session.ids) {
    if (!wrongIds.includes(qid)) agg.delete(qid);
  }
  store.wrongIdsAggregate = [...agg].sort((a, b) => a - b);
  saveStore(store);

  lastResult = result;
  refreshWrongCount();
  session = null;
  renderResult(result);
  showView("result");
}

// ===== Result =====
function attachResultHandlers() {
  document.getElementById("res-redo-wrong").addEventListener("click", () => {
    if (!lastResult || !lastResult.wrongIds.length) { alert("沒有答錯的題目可複習。"); return; }
    beginSession({ mode: "wrong-only", ids: [...lastResult.wrongIds], year: ALL, subject: ALL });
  });
  document.getElementById("res-back-home").addEventListener("click", () => showView("home"));
}

function renderResult(r) {
  document.getElementById("res-score").textContent = r.score;
  document.getElementById("res-total").textContent = r.count;
  document.getElementById("res-pct").textContent = ((r.score / r.count) * 100).toFixed(1);
  document.getElementById("res-duration").textContent = formatDuration(r.durationMs);
  document.getElementById("res-wrong-count").textContent = `（${r.wrongIds.length} 題）`;

  const gradeBox = document.getElementById("res-grade-box");
  const gInfo = (r.year && r.year !== ALL && r.subject && r.subject !== ALL)
    ? computeCapGrade(r.year, r.subject, r.score, r.count)
    : null;
  if (gInfo) {
    const gb = document.getElementById("res-grade");
    gb.textContent = `${gInfo.tier} ${gInfo.grade}`;
    gb.className = `grade-badge ${gInfo.cls}`;
    document.getElementById("res-grade-note").textContent = gInfo.note;
    gradeBox.hidden = false;
  } else {
    gradeBox.hidden = true;
  }

  const ul = document.getElementById("res-wrong-list");
  ul.innerHTML = "";
  for (const qid of r.wrongIds) {
    const q = QUESTIONS.find(x => x.id === qid);
    if (!q) continue;
    const pickedStr = r.answers[qid] || "(未作答)";
    const li = document.createElement("li");
    const brief = q.question.slice(0, 70) + (q.question.length > 70 ? "..." : "");
    li.innerHTML = `
      <div class="qbrief">${escapeHtml(qLabel(q))}　${escapeHtml(brief)}</div>
      <div class="qans">你的答案：<b>${escapeHtml(pickedStr)}</b>　·　正解：<b>${q.answer.join(", ")}</b></div>
      <div class="qdetail"></div>
    `;
    li.addEventListener("click", () => {
      li.classList.toggle("open");
      const det = li.querySelector(".qdetail");
      if (li.classList.contains("open") && !det.dataset.filled) {
        det.dataset.filled = "1";
        let body = "";
        if (q.passage) body += `【題組引文】\n${q.passage}\n\n`;
        body += q.question + "\n";
        for (const [letter, text] of Object.entries(q.options || {})) {
          const mark = q.answer.includes(letter) ? " ✓" : "";
          body += `\n(${letter}) ${text}${mark}`;
        }
        const zhExp = EXPLANATIONS_ZH[q.id]?.explanation_zh;
        if (zhExp) body += `\n\n【詳解】\n${zhExp}`;
        det.textContent = body;
      }
    });
    ul.appendChild(li);
  }
  if (!r.wrongIds.length) {
    const li = document.createElement("li");
    li.textContent = "🎉 全部答對！";
    ul.appendChild(li);
  }
}

// ===== History =====
function attachHistoryHandlers() {
  document.getElementById("hist-clear").addEventListener("click", () => {
    if (!confirm("確定要清除所有測驗紀錄與累積答錯題庫嗎？此動作無法復原。")) return;
    if (!confirm("再次確認：清除後無法復原。")) return;
    localStorage.removeItem(STORAGE_KEY);
    refreshWrongCount();
    renderHistory();
  });
  document.getElementById("detail-back").addEventListener("click", () => {
    renderHistory();
    showView("history");
  });
  document.querySelectorAll(".detail-tab").forEach(b =>
    b.addEventListener("click", () => switchDetailTab(b.dataset.tab)));

  const importFile = document.getElementById("hist-import-file");
  document.getElementById("hist-import").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const file = importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        const r = mergeImported(incoming);
        refreshWrongCount();
        renderHistory();
        alert(`匯入完成：新增 ${r.addedSessions} 筆測驗紀錄、${r.addedNotes} 則筆記（略過 ${r.skippedSessions} 筆已存在紀錄）。`);
      } catch (e) {
        alert(`匯入失敗：檔案格式不正確（${e.message}）`);
      } finally {
        importFile.value = "";
      }
    };
    reader.readAsText(file);
  });
  document.getElementById("hist-export").addEventListener("click", () => {
    const data = localStorage.getItem(STORAGE_KEY) || "{}";
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cap-quiz-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function mergeImported(incoming) {
  if (!incoming || typeof incoming !== "object") throw new Error("不是有效的 JSON 物件");
  const hasData = Array.isArray(incoming.sessions) || incoming.notes || incoming.wrongIdsAggregate;
  if (!hasData) throw new Error("找不到 sessions / notes 等紀錄欄位");

  const store = loadStore();
  const existingIds = new Set(store.sessions.map(s => s.id));
  let addedSessions = 0, skippedSessions = 0;
  for (const s of (Array.isArray(incoming.sessions) ? incoming.sessions : [])) {
    if (!s || s.id == null) continue;
    if (existingIds.has(s.id)) { skippedSessions++; continue; }
    store.sessions.push(s);
    existingIds.add(s.id);
    addedSessions++;
  }
  store.sessions.sort((a, b) => new Date(b.date) - new Date(a.date));

  let addedNotes = 0;
  const inNotes = (incoming.notes && typeof incoming.notes === "object") ? incoming.notes : {};
  for (const [qid, text] of Object.entries(inNotes)) {
    if (text && !(qid in store.notes)) { store.notes[qid] = text; addedNotes++; }
  }

  const agg = new Set(store.wrongIdsAggregate || []);
  for (const id of (Array.isArray(incoming.wrongIdsAggregate) ? incoming.wrongIdsAggregate : [])) agg.add(id);
  store.wrongIdsAggregate = [...agg].sort((a, b) => a - b);

  saveStore(store);
  return { addedSessions, skippedSessions, addedNotes };
}

function renderHistory() {
  const store = loadStore();
  const tbody = document.getElementById("hist-tbody");
  tbody.innerHTML = "";
  const empty = document.getElementById("hist-empty");
  if (!store.sessions || !store.sessions.length) { empty.hidden = false; return; }
  empty.hidden = true;

  for (const s of store.sessions) {
    const tr = document.createElement("tr");
    const modeLabel = ({ sequential: "循序", random: "隨機", "wrong-only": "錯題複習", search: "搜尋結果" })[s.mode] || s.mode;
    const lbl = scopeLabel(s.year || ALL, s.subject || ALL);
    const range = s.rangeStart ? `（${s.rangeStart}-${s.rangeEnd}）` : "";
    const pct = s.count > 0 ? ((s.score / s.count) * 100).toFixed(1) : "0.0";
    let gradeCell = "—";
    if (s.grade) {
      const cls = s.grade.startsWith("A") ? "grade-a" : (s.grade.startsWith("B") ? "grade-b" : "grade-c");
      gradeCell = `<span class="hist-grade ${cls}">${escapeHtml(s.grade)}</span>`;
    }
    tr.innerHTML = `
      <td>${formatDate(s.date)}</td>
      <td>${modeLabel}${range}<br><span class="muted">${escapeHtml(lbl)}</span></td>
      <td><b>${s.score}</b> / ${s.count} 題</td>
      <td>${pct}%</td>
      <td>${gradeCell}</td>
      <td>${s.durationMs != null ? formatDuration(s.durationMs) : "—"}</td>
      <td class="hist-actions">
        <button class="ghost view-detail">查看</button>
        <button class="ghost danger del-session">刪除</button>
      </td>
    `;
    tr.querySelector(".view-detail").addEventListener("click", () => {
      renderDetail(s);
      showView("detail");
    });
    tr.querySelector(".del-session").addEventListener("click", () => {
      if (!confirm("確定刪除這筆測驗紀錄嗎？此動作無法復原。")) return;
      const st = loadStore();
      st.sessions = st.sessions.filter(x => x.id !== s.id);
      saveStore(st);
      renderHistory();
    });
    tbody.appendChild(tr);
  }
}

function renderDetail(s) {
  const pct = s.count > 0 ? ((s.score / s.count) * 100).toFixed(1) : "0.0";
  document.getElementById("detail-score").textContent =
    `${s.score} / ${s.count} 題` + (s.grade ? `（${s.grade}）` : "");
  document.getElementById("detail-pct").textContent =
    `${scopeLabel(s.year || ALL, s.subject || ALL)} · 正確率 ${pct}%`;
  document.getElementById("detail-date").textContent = formatDate(s.date);

  const redoBtn = document.getElementById("detail-redo-wrong");
  const wrongIds = (s.wrongIds || []).filter(id => QUESTIONS.some(q => q.id === id));
  if (wrongIds.length) {
    redoBtn.hidden = false;
    redoBtn.textContent = `重做這次答錯的題目（${wrongIds.length} 題）`;
    redoBtn.onclick = () => beginSession({ mode: "wrong-only", ids: [...wrongIds], year: ALL, subject: ALL });
  } else {
    redoBtn.hidden = true;
    redoBtn.onclick = null;
  }

  const notes = loadStore().notes;
  const wrongUl = document.getElementById("detail-list-wrong");
  const notesUl = document.getElementById("detail-list-notes");
  wrongUl.innerHTML = "";
  notesUl.innerHTML = "";

  let wrongShown = 0, notesShown = 0;
  for (const qid of s.ids) {
    const q = QUESTIONS.find(x => x.id === qid);
    if (!q) continue;
    const picked = s.answers[qid] || "";
    const ok = Boolean(picked && q.answer.includes(picked));
    const note = notes[qid];

    if (!ok) {
      wrongUl.appendChild(detailItem(q, picked, ok, note));
      wrongShown++;
    }
    if (note) {
      notesUl.appendChild(detailItem(q, picked, ok, note));
      notesShown++;
    }
  }

  if (wrongShown === 0) {
    wrongUl.innerHTML = `<li class="muted">🎉 這次全部答對，沒有錯題。</li>`;
  }
  if (notesShown === 0) {
    notesUl.innerHTML = `<li class="muted">這次沒有寫筆記的題目。</li>`;
  }

  document.querySelector('.detail-tab[data-tab="wrong"]').textContent = `答錯（${wrongShown}）`;
  document.querySelector('.detail-tab[data-tab="notes"]').textContent = `筆記（${notesShown}）`;
  switchDetailTab("wrong");
}

function detailItem(q, picked, ok, note) {
  let opts = "";
  for (const [letter, text] of Object.entries(q.options || {})) {
    const isAns = q.answer.includes(letter);
    const isPicked = picked === letter;
    const cls = isAns ? "correct" : (isPicked ? "wrong" : "");
    const mark = isPicked ? ' <span class="pick-mark">（你的選擇）</span>' : "";
    opts += `<li class="${cls}"><span class="opt-letter">(${letter})</span>`
      + `<span class="opt-text">${escapeHtml(text)}${mark}</span></li>`;
  }
  const passageHtml = q.passage
    ? `<details class="passage-box"><summary>題組引文／閱讀文章</summary><div class="passage-body"><div class="passage-text">${escapeHtml(q.passage)}</div>${q.passageImage ? `<div class="passage-img-wrap"><img src="${escapeHtml(q.passageImage)}" alt="題組原卷截圖" loading="lazy" /></div>` : ""}</div></details>`
    : "";
  const imageHtml = q.image
    ? `<details class="image-box"><summary>觀看原卷題目截圖</summary><div class="image-body"><img src="${escapeHtml(q.image)}" alt="原卷截圖" loading="lazy" /></div></details>`
    : "";
  const noteHtml = note
    ? `<div class="note-view"><div class="note-label">我的筆記</div><div class="note-text">${escapeHtml(note)}</div></div>`
    : "";
  const li = document.createElement("li");
  li.className = "detail-item " + (ok ? "ok" : "bad");
  li.innerHTML = `
      <div class="qbrief">${escapeHtml(qLabel(q))} <span class="badge">${escapeHtml(q.category || "")}</span> <span class="detail-mark">${ok ? "✓ 答對" : "✗ 答錯"}</span></div>
      ${passageHtml}
      <div class="detail-stem">${escapeHtml(q.question)}</div>
      <ul class="options detail-options">${opts}</ul>
      <div class="qans muted">你的答案：<b>${escapeHtml(picked || "(未作答)")}</b>　·　正解：<b>${q.answer.join(", ")}</b></div>
      ${imageHtml}
      ${translateDetailsHtml(q)}
      ${explainDetailsHtml(q)}
      ${noteHtml}`;
  return li;
}

function switchDetailTab(tab) {
  document.querySelectorAll(".detail-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("detail-pane-wrong").hidden = tab !== "wrong";
  document.getElementById("detail-pane-notes").hidden = tab !== "notes";
}

function translateDetailsHtml(q) {
  const tr = TRANSLATIONS[q.id];
  if (!tr) return "";
  let tOpts = "";
  for (const letter of Object.keys(q.options || {})) {
    const zh = tr.options_zh ? tr.options_zh[letter] : null;
    if (zh == null) continue;
    tOpts += `<li><span class="opt-letter">(${letter})</span><span class="opt-text">${escapeHtml(zh)}</span></li>`;
  }
  let bodyText = "";
  if (tr.passage_zh) bodyText += `【題組引文翻譯】\n${tr.passage_zh}\n\n`;
  if (tr.question_zh) bodyText += tr.question_zh;
  return `<details class="translate-box"><summary>題目翻譯（繁體中文）</summary>`
    + `<div class="translate-body"><div class="translate-stem">${escapeHtml(bodyText.trim())}</div>`
    + `<ul class="translate-options">${tOpts}</ul></div></details>`;
}

function explainDetailsHtml(q) {
  const expBody = EXPLANATIONS_ZH[q.id]?.explanation_zh;
  if (!expBody) return "";
  return `<details class="explain-en"><summary>詳解</summary>`
    + `<div class="explain-body">${escapeHtml(expBody)}</div></details>`;
}

// ===== Search =====
function attachSearchHandlers() {
  document.getElementById("search-btn").addEventListener("click", runSearch);
  document.getElementById("search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") runSearch();
  });
  document.getElementById("search-quiz").addEventListener("click", () => {
    if (!lastSearchMatches.length) return;
    beginSession({ mode: "search", ids: lastSearchMatches.map(q => q.id), year: ALL, subject: ALL });
  });
}

function runSearch() {
  const query = document.getElementById("search-input").value.trim();
  const results = document.getElementById("search-results");
  const summary = document.getElementById("search-summary");
  const quizBtn = document.getElementById("search-quiz");
  results.innerHTML = "";
  lastSearchMatches = [];
  quizBtn.hidden = true;

  if (!query) { summary.textContent = "請輸入關鍵字。"; return; }

  const ql = query.toLowerCase();
  const notes = loadStore().notes;
  const matches = QUESTIONS.filter(q =>
    q.question.toLowerCase().includes(ql) ||
    (q.passage && q.passage.toLowerCase().includes(ql)) ||
    Object.values(q.options || {}).some(o => String(o).toLowerCase().includes(ql)) ||
    (notes[q.id] && notes[q.id].toLowerCase().includes(ql)));

  lastSearchMatches = matches;
  summary.textContent = `找到 ${matches.length} 題`;
  if (!matches.length) return;

  quizBtn.hidden = false;
  quizBtn.textContent = `測驗這些題目（${matches.length} 題）`;

  const MAX = 300;
  for (const q of matches.slice(0, MAX)) results.appendChild(searchItem(q, query, notes[q.id]));
}

function searchItem(q, query, note) {
  let opts = "";
  for (const [letter, text] of Object.entries(q.options || {})) {
    const cls = q.answer.includes(letter) ? "correct" : "";
    opts += `<li class="${cls}"><span class="opt-letter">(${letter})</span><span class="opt-text">${highlight(text, query)}</span></li>`;
  }
  const passageHtml = q.passage
    ? `<details class="passage-box"><summary>題組引文／閱讀文章</summary><div class="passage-body"><div class="passage-text">${highlight(q.passage, query)}</div></div></details>`
    : "";
  const imageHtml = q.image
    ? `<details class="image-box"><summary>觀看原卷題目截圖</summary><div class="image-body"><img src="${escapeHtml(q.image)}" alt="原卷截圖" loading="lazy" /></div></details>`
    : "";
  const noteHtml = note
    ? `<div class="note-view"><div class="note-label">我的筆記</div><div class="note-text">${highlight(note, query)}</div></div>`
    : "";
  const li = document.createElement("li");
  li.className = "detail-item";
  li.innerHTML = `
      <div class="qbrief">${escapeHtml(qLabel(q))} <span class="badge">${escapeHtml(q.category || "")}</span></div>
      ${passageHtml}
      <div class="detail-stem">${highlight(q.question, query)}</div>
      <ul class="options detail-options">${opts}</ul>
      <div class="qans muted">正解：<b>${q.answer.join(", ")}</b></div>
      ${imageHtml}
      ${translateDetailsHtml(q)}
      ${explainDetailsHtml(q)}
      ${noteHtml}`;
  return li;
}

function highlight(text, query) {
  const esc = escapeHtml(String(text));
  const q = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!q) return esc;
  return esc.replace(new RegExp(q, "gi"), m => `<mark>${m}</mark>`);
}

// ===== Utils =====
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatDate(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

document.addEventListener("DOMContentLoaded", boot);

/* ════════════════════════════════════════════════════════════════
   TEST RUNNER — chạy tuần tự các case trong TEST_CATALOG và render
   kết quả vào tab "Test Runner" (#tc-runner) của cheatTool.

   Phụ thuộc các global có sẵn trong index.html: base(), DBG_TOKEN,
   toast(), escHtml(). Và NagaWsClient, TEST_CATALOG (file js/ trước đó).
   ════════════════════════════════════════════════════════════════ */

const TR = {
  running: false,
  abort: false,
  results: {},      // id → {status, msg, ms, user, logs, frames}
  startedAt: null,
};

const TR_DEFAULTS = {
  timeoutMs: 8000,
};

const TR_LS_PREFIX = 'naga_qc_tr_';

/* ── Config ─────────────────────────────────────────────────── */

function trCfg() {
  const el = document.getElementById('tr-cfg-timeout');
  const t = el && el.value !== '' ? parseInt(el.value, 10) : NaN;
  return {
    // WS URL lấy từ ô dùng chung ở thanh header (hàm wsUrl() của index.html).
    wsUrl: wsUrl(),
    timeoutMs: (!isNaN(t) && t) ? t : TR_DEFAULTS.timeoutMs,
  };
}

function trSaveCfg() {
  const el = document.getElementById('tr-cfg-timeout');
  if (el) localStorage.setItem(TR_LS_PREFIX + 'timeout', el.value);
}

function trRestoreCfg() {
  const el = document.getElementById('tr-cfg-timeout');
  if (!el) return;
  const saved = localStorage.getItem(TR_LS_PREFIX + 'timeout');
  el.value = saved !== null ? saved : TR_DEFAULTS.timeoutMs;
  el.addEventListener('change', trSaveCfg);
}

/* ── REST debug API bám theo người chơi đang chọn ở danh sách trái ── */

function trMakeApi(user, getJoined) {
  async function rest(method, path, body) {
    try {
      const res = await fetch(base() + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Debug-Token': DBG_TOKEN },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* body rỗng */ }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e.message } };
    }
  }
  // Cheat key phía naga = (agency, stableId) của SESSION — lấy từ reply JOIN
  // (cmd 1005 trả về agency/userId/stableId thật), fallback về giá trị cấp phát.
  const who = () => {
    const j = getJoined ? getJoined() : null;
    const userId = (j && j.userId) || user.userId;
    return {
      agency: (j && j.agency) || user.agency,
      userId,
      stableId: (j && j.stableId) || userId,
      gameId: (j && j.gameId) || user.gameId || 'game-naga-fortune-777',
    };
  };
  return {
    raw: rest,
    armCheat: (cheat, value) => {
      const w = who();
      return rest('POST', '/api/v1/debug/cheat/' + w.agency + '/' + w.stableId, { cheat, value: value || {} });
    },
    setBalance: (v) => {
      const w = who();
      return rest('POST', '/api/v1/debug/wallet/' + w.agency + '/' + w.stableId, { balance: String(v) });
    },
    /** Arm thẳng Treasure Room (Naga Eye) không cần spin — đáng tin hơn FORCE_NAGA_EYE. */
    armTreasureRoom: () => {
      const w = who();
      return rest('POST', '/api/v1/debug/treasure-room/' + w.agency + '/' + w.stableId
        + '?gameId=' + encodeURIComponent(w.gameId), null);
    },
  };
}

/* ── Assert collector ───────────────────────────────────────── */

class TrAbort extends Error {}

function trMakeAsserts() {
  const A = {
    failures: [],
    _rec(ok, msg) { if (!ok) A.failures.push(msg); return !!ok; },
    ok(cond, msg) { return A._rec(cond, msg); },
    eq(actual, expected, label) {
      return A._rec(actual === expected,
        label + ': kỳ vọng ' + JSON.stringify(expected) + ', nhận ' + JSON.stringify(actual));
    },
    near(actual, expected, label, eps) {
      const e = (eps === undefined) ? 0.005 : eps;
      const a = TCH.num(actual);
      return A._rec(!isNaN(a) && Math.abs(a - expected) <= e,
        label + ': kỳ vọng ≈' + expected + ', nhận ' + JSON.stringify(actual));
    },
    has(obj, path, label) {
      return A._rec(TCH.pick(obj, path) !== undefined,
        (label || path) + ': thiếu field "' + path + '" (chú ý wsproxy drop field null)');
    },
    type(v, t, label) {
      return A._rec(typeof v === t, label + ': kỳ vọng kiểu ' + t + ', nhận ' + typeof v);
    },
    /** Assert bắt buộc — sai thì dừng case ngay (FAIL). */
    must(cond, msg) { if (!A._rec(cond, msg)) throw new TrAbort(msg); },
  };
  return A;
}

/* ── Chạy case ──────────────────────────────────────────────── */

async function trRunSingle(c) {
  const t0 = Date.now();
  if (c.mode === 'SKIP') {
    TR.results[c.id] = { status: 'SKIP', msg: c.skipReason || '', ms: 0, user: '', logs: [], frames: [] };
    trRenderRow(c.id);
    return;
  }
  const cfg = trCfg();
  const user = selectedPlayer();   // danh tính lấy từ người chơi đang chọn ở danh sách trái
  if (!user) {
    // Người chơi bị bỏ chọn giữa chừng (vd thoát game, poll tự clear) — fail gọn, dừng suite.
    TR.results[c.id] = { status: 'FAIL', msg: 'Mất người chơi đang chọn (đã thoát game?) — hãy chọn lại bên trái', ms: 0, user: '', logs: [], frames: [] };
    trRenderRow(c.id);
    TR.abort = true;
    return;
  }
  const ws = new NagaWsClient({ url: cfg.wsUrl });
  const extraWs = [];
  const A = trMakeAsserts();
  const logs = [];
  const ctx = {
    user, ws, A, cfg,
    log: (m) => logs.push(m),
    joined: null,
    /** Mở thêm kết nối WS mới (case reconnect) — runner tự đóng giúp khi xong. */
    newWs() {
      const w = new NagaWsClient({ url: cfg.wsUrl });
      extraWs.push(w);
      return w;
    },
  };
  ctx.api = trMakeApi(user, () => ctx.joined);

  TR.results[c.id] = { status: 'RUN', msg: '', ms: 0, user: user.userId, logs, frames: ws.frames };
  trRenderRow(c.id);

  let status = 'PASS';
  let msg = '';
  try {
    // Chuẩn hóa số dư trước mỗi case: cùng một người chơi chạy nhiều case liên tiếp
    // nên có thể dính balance thấp (3) do case guard của lượt trước để lại
    const seed = await ctx.api.setBalance(10000000);
    if (!seed.ok) logs.push('Cảnh báo: không chuẩn hóa được balance (HTTP ' + seed.status + ')');
    await c.run(ctx);
    if (A.failures.length) { status = 'FAIL'; msg = A.failures.join(' • '); }
  } catch (e) {
    status = 'FAIL';
    const extra = (e instanceof TrAbort) ? '' : e.message;
    msg = A.failures.concat(extra ? [extra] : []).join(' • ');
  } finally {
    try { ws.close(); } catch (e) { /* bỏ qua */ }
    extraWs.forEach((w) => { try { w.close(); } catch (e) { /* bỏ qua */ } });
  }

  const allFrames = ws.frames
    .concat(extraWs.flatMap((w) => w.frames))
    .sort((a, b) => a.at - b.at);
  TR.results[c.id] = { status, msg, ms: Date.now() - t0, user: user.userId, logs, frames: allFrames };
  trRenderRow(c.id);
  trRenderSummary();
}

async function trRunList(list) {
  if (TR.running) { toast('⚠ Suite đang chạy, bấm Dừng trước đã', 'warn'); return; }
  if (!list.length) { toast('⚠ Không có case nào để chạy', 'warn'); return; }
  if (!selectedPlayer()) { toast('⚠ Hãy chọn 1 người chơi ở danh sách bên trái trước', 'warn'); return; }
  TR.running = true;
  TR.abort = false;
  TR.startedAt = new Date().toISOString();
  document.getElementById('tr-btn-stop').disabled = false;
  for (const c of list) {
    if (TR.abort) break;
    await trRunSingle(c);
  }
  TR.running = false;
  document.getElementById('tr-btn-stop').disabled = true;
  trRenderSummary();
  toast(TR.abort ? '⚠ Đã dừng theo yêu cầu' : '✅ Chạy xong suite', TR.abort ? 'warn' : 'success');
}

function trRunAll() { trRunList(TEST_CATALOG.cases); }

function trRunGroup() {
  const g = document.getElementById('tr-group-select').value;
  trRunList(TEST_CATALOG.cases.filter((c) => c.group === g));
}

function trRunOne(id) {
  const c = TEST_CATALOG.get(id);
  if (c) trRunList([c]);
}

function trStop() { TR.abort = true; }

/* ── Render UI ──────────────────────────────────────────────── */

function trBadge(status) {
  const cls = { PASS: 'tr-pass', FAIL: 'tr-fail', SKIP: 'tr-skip', RUN: 'tr-run' }[status] || 'tr-idle';
  const text = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', RUN: '…' }[status] || '—';
  return '<span class="tr-badge ' + cls + '">' + text + '</span>';
}

function trRenderTable() {
  const tbody = document.getElementById('tr-tbody');
  if (!tbody) return;
  let html = '';
  let lastGroup = null;
  TEST_CATALOG.cases.forEach((c) => {
    if (c.group !== lastGroup) {
      lastGroup = c.group;
      html += '<tr class="tr-group-row"><td colspan="6">' + escHtml(c.group) + '</td></tr>';
    }
    html += '<tr id="tr-row-' + c.id + '" class="tr-case-row" onclick="trToggleDetail(\'' + c.id + '\')">'
      + '<td id="tr-st-' + c.id + '">' + trBadge(null) + '</td>'
      + '<td class="tr-id">' + escHtml(c.id) + '</td>'
      + '<td>' + escHtml(c.title) + '</td>'
      + '<td id="tr-user-' + c.id + '" class="tr-dim"></td>'
      + '<td id="tr-ms-' + c.id + '" class="tr-dim"></td>'
      + '<td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();trRunOne(\'' + c.id + '\')">▶</button></td>'
      + '</tr>'
      + '<tr id="tr-detail-' + c.id + '" class="tr-detail" style="display:none"><td colspan="6">'
      + '<pre class="json-box" id="tr-detail-pre-' + c.id + '"></pre></td></tr>';
  });
  tbody.innerHTML = html;
}

function trRenderRow(id) {
  const r = TR.results[id];
  if (!r) return;
  const st = document.getElementById('tr-st-' + id);
  if (st) st.innerHTML = trBadge(r.status);
  const u = document.getElementById('tr-user-' + id);
  if (u) u.textContent = r.user ? ('u' + r.user) : '';
  const ms = document.getElementById('tr-ms-' + id);
  if (ms) ms.textContent = r.ms ? (r.ms + 'ms') : '';
  const row = document.getElementById('tr-row-' + id);
  if (row) row.className = 'tr-case-row tr-row-' + (r.status || '').toLowerCase();
  // Cập nhật luôn nội dung detail nếu đang mở
  const pre = document.getElementById('tr-detail-pre-' + id);
  const detail = document.getElementById('tr-detail-' + id);
  if (pre && detail && detail.style.display !== 'none') pre.textContent = trDetailText(id);
}

function trDetailText(id) {
  const c = TEST_CATALOG.get(id);
  const r = TR.results[id];
  if (!r) return '(chưa chạy)';
  const lines = [];
  lines.push(c.id + ' — ' + c.title);
  lines.push('Trạng thái: ' + r.status + (r.ms ? ('  ·  ' + r.ms + 'ms') : '') + (r.user ? ('  ·  user ' + r.user) : ''));
  if (r.msg) lines.push('\nLý do:\n  ' + r.msg.split(' • ').join('\n  '));
  if (r.logs && r.logs.length) lines.push('\nLog:\n  ' + r.logs.join('\n  '));
  if (r.frames && r.frames.length) {
    lines.push('\nFrames (' + r.frames.length + '):');
    r.frames.forEach((f) => {
      lines.push('  ' + (f.dir === 'out' ? '→' : '←') + ' ' + JSON.stringify(f.frame));
    });
  }
  return lines.join('\n');
}

function trToggleDetail(id) {
  const row = document.getElementById('tr-detail-' + id);
  const pre = document.getElementById('tr-detail-pre-' + id);
  if (!row) return;
  const show = row.style.display === 'none';
  row.style.display = show ? '' : 'none';
  if (show && pre) pre.textContent = trDetailText(id);
}

function trRenderSummary() {
  const el = document.getElementById('tr-summary');
  if (!el) return;
  const all = TEST_CATALOG.cases.length;
  let pass = 0, fail = 0, skip = 0, run = 0;
  Object.values(TR.results).forEach((r) => {
    if (r.status === 'PASS') pass++;
    else if (r.status === 'FAIL') fail++;
    else if (r.status === 'SKIP') skip++;
    else if (r.status === 'RUN') run++;
  });
  el.innerHTML =
    '<span class="tr-badge tr-pass">PASS ' + pass + '</span> '
    + '<span class="tr-badge tr-fail">FAIL ' + fail + '</span> '
    + '<span class="tr-badge tr-skip">SKIP ' + skip + '</span> '
    + '<span class="tr-dim">· ' + (pass + fail + skip) + '/' + all + ' case'
    + (run ? ' · đang chạy…' : '') + '</span>';
}

/* ── Export báo cáo JSON ────────────────────────────────────── */

function trExport() {
  const cfg = trCfg();
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt: TR.startedAt,
    wsUrl: cfg.wsUrl,
    restBase: base(),
    summary: {},
    cases: TEST_CATALOG.cases.map((c) => {
      const r = TR.results[c.id] || { status: 'NOT_RUN' };
      return {
        id: c.id, group: c.group, title: c.title,
        status: r.status, durationMs: r.ms || 0, user: r.user || null,
        failures: r.msg || null, logs: r.logs || [], frames: r.frames || [],
      };
    }),
  };
  ['PASS', 'FAIL', 'SKIP', 'NOT_RUN'].forEach((s) => {
    report.summary[s] = report.cases.filter((x) => x.status === s).length;
  });
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'naga-happy-report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Khởi tạo tab ───────────────────────────────────────────── */

function trInit() {
  const sel = document.getElementById('tr-group-select');
  if (sel) {
    sel.innerHTML = TEST_CATALOG.groups()
      .map((g) => '<option value="' + escHtml(g) + '">' + escHtml(g) + '</option>')
      .join('');
  }
  trRestoreCfg();
  trRenderTable();
  trRenderSummary();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', trInit);
} else {
  trInit();
}

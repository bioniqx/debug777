/* ════════════════════════════════════════════════════════════════
   ws-debug.js — Chế độ WebSocket cho cheatTool (mới, cộng thêm bên
   cạnh REST). Không đụng gì tới nhánh fetch REST cũ trong call() —
   index.html chỉ thêm 1 nhánh rẽ ở đầu call(), gọi wsDebugCall() ở
   đây; nếu path không map được op nào thì trả về falsy để call()
   rơi về fetch REST như cũ.

   Gồm:
     - toolWs: 1 NagaWsClient dùng chung cho mọi debug op, tự AUTH+JOIN
       ở lần gọi đầu, tự nối lại khi rớt.
     - WS_ROUTES: bảng (method, path) → (op, params) cho cả 31 op debug.
     - 4 adapter cho các op có "data" khác REST body (đổi từ handler gRPC
       tái dùng thay vì controller cũ): HISTORY_ROUNDS, HISTORY_ROUND_DETAIL,
       HISTORY_ROUND_REPLAY, JACKPOT_LEADERBOARD.
     - UI glue: mode toggle (REST/WS, mặc định WS mỗi lần tải trang), cấu hình
       WS URL/agentId/đăng nhập (localStorage), preset LOCAL/STAG, nút "Kết nối".

   Chạy được cả trong browser (index.html nạp qua <script src>, sau
   ws-client.js) lẫn Node (require() để viết script probe/so sánh
   REST vs WS — xem cheatTool/run-headless.js cho cách dùng NagaWsClient
   ngoài browser).
   ════════════════════════════════════════════════════════════════ */

const NagaWsClientRef = (typeof NagaWsClient !== 'undefined')
  ? NagaWsClient
  : (typeof require === 'function' ? require('./ws-client.js').NagaWsClient : undefined);

// DBG_TOKEN đã có sẵn ở index.html (cùng scope global của trang); Node không có nên fallback literal.
const DEBUG_TOKEN = (typeof DBG_TOKEN !== 'undefined') ? DBG_TOKEN : 'slot-engine-debug';

function hasDom() { return typeof document !== 'undefined'; }

/* ── Cấu hình phiên WS của tool (WS URL / accessToken / agentId) ──────── */

const WS_CFG_LS = { url: 'naga_qc_ws_url', agent: 'naga_qc_ws_agent', user: 'naga_qc_ws_user', pass: 'naga_qc_ws_pass' };

// Giá trị lấy từ local_login.md và staging_login.md. Riêng tài khoản staging dùng Admin101 chứ
// không phải KOL-001 như trong tài liệu: đó là tài khoản riêng của tool, để tool không giành
// phiên với QC đang test (xem lý do ở comment 'local' ngay dưới — TokenRegistry khoá theo username).
// Local có seed token cố định nên không phải đăng nhập; staging phải qua luồng 2 bước.
const WS_PRESETS = {
  // Token 100 chứ không phải 001: TokenRegistry của BE khoá theo username, nên nếu tool JOIN trùng
  // danh tính với một người chơi thật thì nó GHI ĐÈ phiên của người đó — người chơi biến mất khỏi
  // danh sách và cheat nhắm vào họ cũng trượt. Dải 001-046 là của run-headless.js và của QC khi
  // test tay, nên tool lấy đuôi 100 cho khỏi đụng.
  local: { url: 'ws://localhost:9099/websocket', agent: '1', token: '1-valid-token-100' },
  stag: {
    url: 'wss://gob02-ws.relaxwmestu.xyz/websocket',
    agent: 'AGENCY_001',
    authHost: 'https://agency001.relaxwmestu.xyz',
    user: 'Admin101',
    pass: '12345',
  },
};

// Ngoài browser (Node probe script), đọc từ globalThis.WS_TOOL_CONFIG = {url, agent, user, pass}.
function wsCfgRaw(key) {
  if (hasDom()) {
    const el = document.getElementById('i-ws-' + key);
    return el ? el.value.trim() : '';
  }
  return String((globalThis.WS_TOOL_CONFIG || {})[key] || '').trim();
}
function wsCfgUrl() { return wsCfgRaw('url') || WS_PRESETS.local.url; }
function wsCfgAgent() { return wsCfgRaw('agent') || WS_PRESETS.local.agent; }
function wsCfgUser() { return wsCfgRaw('user') || WS_PRESETS.stag.user; }
function wsCfgPass() { return wsCfgRaw('pass') || WS_PRESETS.stag.pass; }

// Local nhận ra qua host, không qua việc bấm preset — QC gõ tay URL localhost vẫn phải đúng.
function wsIsLocal() {
  return /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(wsCfgUrl());
}

// Token staging hết hạn (~1 giờ theo staging_login.md) nên giữ trong RAM, không lưu localStorage:
// một token cũ nằm lại sau khi đóng tab chỉ gây lỗi AUTH khó hiểu ở lần mở sau.
let stagToken = null;

// Mở tool lên là vào thẳng WS. Cố ý KHÔNG lưu localStorage: lưu thì lần bấm REST gần nhất sẽ
// dính lại và lần mở sau không còn mặc định WS nữa. Bấm REST vẫn có hiệu lực trong phiên, F5
// là quay về WS.
let _transportMode = 'ws';

function transportMode() {
  return _transportMode;
}

function setTransportMode(mode) {
  _transportMode = mode;
  if (!hasDom()) return;
  const restBtn = document.getElementById('btn-mode-rest');
  const wsBtn = document.getElementById('btn-mode-ws');
  const wsRow = document.getElementById('ws-cfg-row');
  if (restBtn) restBtn.style.opacity = mode === 'rest' ? '1' : '.5';
  if (wsBtn) wsBtn.style.opacity = mode === 'ws' ? '1' : '.5';
  if (wsRow) wsRow.style.display = mode === 'ws' ? '' : 'none';
  updateRestVisibility(mode);
  const badge = document.getElementById('st-mode');
  if (badge) {
    badge.textContent = mode === 'ws' ? 'WS' : 'REST';
    badge.className = 'sbadge ' + (mode === 'ws' ? 'sbadge-warn' : 'sbadge-mute');
  }
}

function saveWsConfig() {
  if (!hasDom()) return;
  Object.keys(WS_CFG_LS).forEach((k) => {
    const el = document.getElementById('i-ws-' + k);
    if (el) localStorage.setItem(WS_CFG_LS[k], el.value.trim());
  });
  resetToolWs(); // cấu hình đổi -> phiên cũ (nếu có) không còn hợp lệ, nối lại ở lần gọi kế tiếp
  updateWsAuthVisibility(); // gõ tay URL sang staging cũng phải hiện ô đăng nhập
  // Nhãn "Đã nối ✓" của phiên vừa bị huỷ sẽ nói dối nếu để nguyên.
  const connBtn = document.getElementById('btn-ws-connect');
  if (connBtn) { connBtn.textContent = 'Kết nối'; connBtn.disabled = false; }
}

// Mặc định lấy thẳng từ local_login.md / staging_login.md — mở tool lên là chạy được ngay,
// không phải tra tài liệu rồi gõ lại.
const WS_CFG_DEFAULTS = {
  url: WS_PRESETS.local.url,
  agent: WS_PRESETS.local.agent,
  user: WS_PRESETS.stag.user,
  pass: WS_PRESETS.stag.pass,
};

function restoreWsConfig() {
  if (!hasDom()) return;
  Object.keys(WS_CFG_LS).forEach((k) => {
    const el = document.getElementById('i-ws-' + k);
    if (el) el.value = localStorage.getItem(WS_CFG_LS[k]) || WS_CFG_DEFAULTS[k] || '';
  });
  setTransportMode(transportMode());
  updateWsAuthVisibility();
}

// Ở mode WS thì Base URL và 2 nút preset của nó không còn điều khiển gì nữa — ẩn đi để QC không
// sửa nhầm một ô vô tác dụng rồi ngồi đoán vì sao không ăn.
// Ô Base vốn còn nuôi wsUrl() cho Test Runner, nên wsUrl() đã được cho đọc ô WS URL khi ở mode WS
// (index.html) — ẩn ở đây mới an toàn, không cắt mất control mà Test Runner đang dùng.
function updateRestVisibility(mode) {
  if (!hasDom()) return;
  const display = mode === 'ws' ? 'none' : '';
  ['i-base', 'btn-base-stag', 'btn-base-local'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  });
  // Ẩn các ô con thôi chưa đủ: khối REST vẫn giữ `flex: 1` nên nó ôm hết chỗ trống và đẩy hàng WS
  // dạt sang phải. Ở mode WS cho nó co về đúng bề rộng 2 nút REST/WS còn hiện.
  const restRow = document.getElementById('rest-cfg-row');
  if (restRow) restRow.style.flex = mode === 'ws' ? '0 0 auto' : '';
}

// Local không cần đăng nhập nên ẩn hẳn username/password — bớt thứ gây phân tâm và bớt cơ hội
// QC tưởng phải điền mới chạy được.
function updateWsAuthVisibility() {
  if (!hasDom()) return;
  const display = wsIsLocal() ? 'none' : '';
  ['i-ws-user', 'i-ws-pass'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  });
}

function setWsPreset(which) {
  if (!hasDom()) return;
  const p = WS_PRESETS[which];
  if (!p) return;
  const urlEl = document.getElementById('i-ws-url');
  const agentEl = document.getElementById('i-ws-agent');
  if (urlEl) urlEl.value = p.url;
  if (agentEl) agentEl.value = p.agent;
  // Preset phải trả về trọn bộ của môi trường đó, kể cả tài khoản. Trước đây chỉ đổi url+agent
  // nên bấm STAG xong vẫn còn tài khoản của lần gõ trước nằm lại trong ô (và trong localStorage).
  const userEl = document.getElementById('i-ws-user');
  const passEl = document.getElementById('i-ws-pass');
  if (p.user && userEl) userEl.value = p.user;
  if (p.pass && passEl) passEl.value = p.pass;
  stagToken = null;              // đổi môi trường thì token cũ không còn đúng chỗ
  saveWsConfig();
  updateWsAuthVisibility();
}

// Luồng 2 bước của agency-platform theo staging_login.md: /user/login lấy token tài khoản, rồi
// /play-game đổi sang token game — chính token game mới dùng để AUTH vào WebSocket.
// Host này là nền tảng của khách hàng, không phải game backend, nên gọi HTTP ở đây là đúng và
// không đi ngược mục tiêu bỏ REST vào game BE.
async function stagLogin() {
  const host = WS_PRESETS.stag.authHost;
  const username = wsCfgUser();
  const password = wsCfgPass();

  const loginRes = await fetch(host + '/api/v1/user/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginData = await loginRes.json();
  const loginToken = loginData && (loginData.token || (loginData.data && loginData.data.token));
  if (!loginRes.ok || !loginToken) throw new Error('Đăng nhập thất bại: ' + JSON.stringify(loginData));

  const gid = (typeof gameId === 'function' ? gameId() : '') || 'game-naga-fortune-777';
  const playRes = await fetch(host + '/api/v1/play-game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + loginToken },
    body: JSON.stringify({ gameId: gid }),
  });
  const playData = await playRes.json();
  const gameToken = playData && (playData.token || (playData.data && playData.data.token));
  if (!playRes.ok || !gameToken) throw new Error('play-game thất bại: ' + JSON.stringify(playData));
  return gameToken;
}

/** Token để AUTH: local dùng seed cố định, staging đăng nhập lấy về (có nhớ lại trong phiên). */
async function resolveWsToken(forceRefresh) {
  if (wsIsLocal()) return WS_PRESETS.local.token;
  if (stagToken && !forceRefresh) return stagToken;
  stagToken = await stagLogin();
  return stagToken;
}

/** Nút "Kết nối": dựng phiên WS ngay theo local_login.md / staging_login.md —
 *  mở WebSocket → AUTH (frame 1) → JOIN (cmd 1005). Nối lười vẫn giữ nguyên cho các op,
 *  nút này chỉ để QC biết ngay cấu hình đúng hay sai thay vì đợi tới lệnh debug đầu tiên. */
async function wsConnect() {
  const btn = hasDom() ? document.getElementById('btn-ws-connect') : null;
  const setBtn = (text, disabled) => {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = !!disabled;
  };
  setBtn('Đang nối…', true);
  try {
    // Bấm lại là nối lại từ đầu: bỏ cả token staging đang nhớ trong phiên, để token hết hạn
    // (~1 giờ) được đăng nhập lấy mới — đây là cách duy nhất làm mới token mà không phải F5.
    resetToolWs();
    stagToken = null;
    const client = await ensureToolWs();
    const j = client.joined || {};
    // Hiện cả stableId: đó mới là giá trị các debug op dùng để nhắm mục tiêu, còn userId là tên
    // đăng nhập. Lẫn hai cái này là mất thời gian ngồi dò vì sao cheat không ăn.
    const who = j.userId
      ? (j.agency || '?') + '/' + j.userId + (j.stableId ? ' · stableId=' + j.stableId : '')
      : 'không rõ danh tính';
    // Bước cuối: lấy danh sách user đang kết nối qua cmd 1900 (op SESSION_WS_LIST). Dùng lại
    // listSessions() của index.html — ở mode WS nó đã tự đi đường cmd 1900 — nên panel bên trái
    // được vẽ lại luôn, không phải gọi thêm lần nữa chỉ để đếm.
    // listSessions() trả undefined khi poll 5 giây chen ngang và nó tự bỏ kết quả (cơ chế _listSeq).
    // Khi đó danh sách vẫn được poll vẽ đúng, chỉ là ta không có số để khoe — đừng in "undefined".
    let found = null;
    try {
      if (typeof listSessions === 'function') {
        const n = await listSessions();
        found = typeof n === 'number' ? n : null;
      }
    } catch (e) {
      found = null;  // danh sách hỏng không làm hỏng kết nối vừa dựng được
    }

    setBtn('Đã nối ✓', false);
    const msg = 'Đã kết nối WS · sessionId=' + client.sessionId + ' · ' + who
      + (found === null ? ' · không lấy được danh sách user' : ' · ' + found + ' user đang kết nối');
    if (typeof toast === 'function') toast(msg, 'success'); else console.log(msg);
  } catch (e) {
    setBtn('Kết nối', false);
    const msg = 'Kết nối WS thất bại: ' + e.message;
    if (typeof toast === 'function') toast(msg, 'error'); else alert(msg);
  }
}

/** Phiên WS của chính tool có nằm trong danh sách người chơi (nó cũng là 1 kết nối thật).
 *  Dùng để đánh dấu, tránh QC bấm "Dùng" vào chính tool rồi cheat lên hư không.
 *  So bằng stableId + agency; staging không có stableId thì lùi về username. */
function isToolSession(u) {
  const j = toolWs && toolWs.joined;
  if (!j || !u) return false;
  if (String(u.agency || '') !== String(j.agency || '')) return false;
  if (j.stableId && u.stableId) return String(u.stableId) === String(j.stableId);
  return !!j.userId && String(u.username || u.userId) === String(j.userId);
}

/* ── toolWs — 1 NagaWsClient dùng chung cho mọi debug op ──────────────── */

let toolWs = null;
let toolWsConnecting = null;

// Seed token local theo quy ước có sẵn của run-headless.js/test-catalog: '1-valid-token-NNN' ↔
// userId 'test-user-NNN'. JOIN chỉ cần MỘT danh tính hợp lệ để tạo TokenRegistry.Entry (§2.3) —
// debug op tự mang agency/userId/gameId đích riêng trong payload (quyết định #6), không dùng entry
// của người gọi, nên danh tính JOIN ở đây không cần khớp người chơi đang bị tác động.
function toolIdentityFromToken(token) {
  const m = /(\d+)\s*$/.exec(token || '');
  return 'test-user-' + (m ? m[1].padStart(3, '0') : '001');
}

function wsIsOpen(client) {
  return !!(client && client.ws && client.ws.readyState === 1);
}

function resetToolWs() {
  if (toolWs) { try { toolWs.close(); } catch (e) { /* bỏ qua */ } }
  toolWs = null;
  toolWsConnecting = null;
}

/** Trả về 1 toolWs đã AUTH+JOIN xong. Tự nối (lười) ở lần gọi đầu, tự nối lại khi rớt. */
async function ensureToolWs() {
  if (wsIsOpen(toolWs)) return toolWs;
  if (toolWsConnecting) return toolWsConnecting;
  toolWsConnecting = (async () => {
    const token = await resolveWsToken(false);
    const client = new NagaWsClientRef({ url: wsCfgUrl() });
    await client.connect();
    await client.auth(token, wsCfgAgent());
    let joined;
    if (wsIsLocal()) {
      const identity = toolIdentityFromToken(token);
      joined = await client.join(identity, identity);
    } else {
      // staging_login.md: JOIN chỉ gửi cmd 1005, danh tính suy từ token AUTH chứ không tự khai.
      joined = await client.join(undefined, undefined);
    }
    client.joined = joined;  // nút "Kết nối" hiện lại danh tính thật mà server cấp
    toolWs = client;
    return client;
  })();
  try {
    return await toolWsConnecting;
  } finally {
    toolWsConnecting = null;
  }
}

/** Gọi 1 debug op, trả về {ok, status, data} — cùng khuôn REST call() để renderer không đổi. */
// Timeout KHÔNG có nghĩa là lệnh chưa chạy — reply có thể mất trong khi server đã thực thi xong.
// Với các op này, gọi lại là làm thêm một lần thật: sinh thêm một lô dữ liệu, quay thêm một loạt
// spin và trừ tiền thật. Nối lại thì được, nhưng tuyệt đối không tự gửi lại lệnh.
const NO_RETRY_OPS = new Set([
  'HISTORY_BULK_GENERATE',
  'JACKPOT_HISTORY_BULK_GENERATE',
  'BULK_BUY_DEBUG',
  'SESSION_REGISTER',
]);

function isTimeoutOrDropped(err) {
  const m = String((err && err.message) || '');
  return m.startsWith('Timeout') || m.includes('WebSocket') || m.includes('đóng');
}

async function wsDebugExec(op, params) {
  const call = async () => {
    const client = await ensureToolWs();
    return client.debug(op, { token: DEBUG_TOKEN, ...params }, 8000);
  };
  try {
    return { ok: true, status: 200, data: await call() };
  } catch (e) {
    if (!isTimeoutOrDropped(e)) return { ok: false, status: 0, data: { error: e.message } };

    // Phiên gần như chắc chắn đã hỏng — dựng lại để lần gọi sau không dính tiếp.
    resetToolWs();

    if (NO_RETRY_OPS.has(op)) {
      return { ok: false, status: 0, data: {
        error: e.message + ' — đã kết nối lại nhưng KHÔNG tự gửi lại "' + op
          + '" vì lệnh có thể đã chạy ở server. Kiểm tra kết quả rồi tự bấm lại nếu cần.',
      } };
    }
    try {
      return { ok: true, status: 200, data: await call(), retried: true };
    } catch (e2) {
      return { ok: false, status: 0, data: { error: e2.message + ' (đã thử kết nối lại 1 lần)' } };
    }
  }
}

/* ── Tiện ích số tiền: WS trả display units, REST trả minor units (cent) ── */
function toMinor(display) {
  if (display === null || display === undefined) return display;
  const n = Number(display);
  return isNaN(n) ? display : Math.round(n * 100);
}

// REST serialize Instant thành số giây-epoch có phần thập phân (Jackson mặc định); WS (SpinListHandler/
// SpinDetailHandler) trả chuỗi ISO-8601. Quy về cùng dạng REST (số giây) cho đúng nghĩa "REST shape",
// để bên gọi không phải phân biệt 2 chế độ. Tab Lịch Sử đã bỏ, giờ chỉ còn Node probe dùng route này.
function toEpochSecondsRaw(iso) {
  if (!iso) return iso;
  const t = Date.parse(iso);
  return isNaN(t) ? iso : t / 1000;
}

// userId hiện tại: HISTORY_ROUND_DETAIL đi qua delegateHistoryOp ở BE — handler dùng chung với
// HISTORY_ROUNDS nên đòi cả agency LẪN userId ở top-level, dù REST /rounds/{roundId} chỉ cần agency.
// Lấy từ người chơi đang chọn trên header — Node probe không có DOM nên fallback
// globalThis.WS_TOOL_CONFIG.
function currentUserId(q) {
  if (typeof userId === 'function') return userId();
  return (globalThis.WS_TOOL_CONFIG && globalThis.WS_TOOL_CONFIG.userId) || (q && q.get('userId')) || '';
}

/* ── 3 (thực ra 4 — xem HISTORY_ROUND_REPLAY) adapter: data khác REST body ── */

function adaptHistoryRounds(r, ctx) {
  if (!r.ok) return r;
  const d = r.data || {};
  // nextMode/hasJackpot: SpinListHandler.histMap() (BE, đã build sẵn) không có 2 field này — REST
  // summary() thì có. Không có cách phục hồi từ dữ liệu WS trả về (không phải lỗi adapter, mà là
  // khoảng trống dữ liệu ở tầng BE) — cột "Mode kế tiếp"/◆ jackpot ở bảng lịch sử luôn hiện "—" khi
  // ở chế độ WS. Xem phần "Notes" trong báo cáo bàn giao.
  const rounds = (d.spins || []).map((s) => ({
    roundId: s.roundId, parentRoundId: null, gameId: s.gameId, sessionId: null,
    mode: s.mode, nextMode: null,
    betAmount: toMinor(s.betAmount), totalWin: toMinor(s.totalWin), profit: toMinor(s.profit),
    transactionId: s.transactionId, status: s.status, title: s.title,
    freeSpinsRemain: null, spinType: s.spinType, hasJackpot: false, timestamp: toEpochSecondsRaw(s.timestamp),
  }));
  return {
    ok: true, status: 200, data: {
      agency: ctx.q.get('agency') || '', userId: ctx.q.get('userId') || '', gameId: ctx.q.get('gameId') || '',
      limit: d.limit, offset: d.offset, count: d.count, rounds,
    },
  };
}

function adaptHistoryRoundDetail(r, ctx) {
  if (!r.ok) return r;
  const d = r.data || {};
  const list = d.rounds || [];
  const wantedId = ctx.args.roundId;
  const rr = list.find((x) => x.roundId === wantedId) || list[0] || {};
  return {
    ok: true, status: 200, data: {
      roundId: rr.roundId, parentRoundId: rr.parentRoundId || null, sessionId: rr.sessionId || null,
      mode: rr.mode, nextMode: null,
      betAmount: toMinor(rr.betAmount), totalWin: toMinor(rr.totalWin), profit: toMinor(rr.profit),
      transactionId: rr.transactionId, status: 'COMPLETED', title: rr.title,
      freeSpinsRemain: null, spinType: rr.spinType, hasJackpot: false, timestamp: toEpochSecondsRaw(rr.timestamp),
      screen: rr.screen,
      wins: (rr.wins || []).map((w) => ({ ...w, payout: toMinor(w.payout) })),
      freeSpinsTotal: null, respinsRemain: null,
      jackpotWonTier: null, jackpotWonAmount: null, jackpotContribution: null,
      balanceBefore: toMinor(rr.balanceBefore), balanceAfter: toMinor(rr.balanceAfter),
      winCapInfo: rr.winCapInfo, trialMode: false,
      topReel: rr.topReel, reelHeights: rr.reelHeights, cascadeLevel: rr.cascadeLevel, multiplier: rr.multiplier,
      wildTransform: { silver: [], gold: [], wild: [] }, netZone: null, cascadeStepsJson: null,
      roundNumber: null, groupId: d.groupId || null, groupType: d.groupType || null, count: d.count,
    },
  };
}

// HISTORY_ROUND_REPLAY không nằm trong 3 op được nêu, nhưng đọc DebugCommandHandler.replayShape()
// thì thấy nó cũng gọi GrpcResponseMapper.toDisplayDouble cho totalWin/betAmount/wins[].payout,
// trong khi GameplayHistoryController.replayShape() trả BigDecimal thô (minor units) — cùng loại
// lệch scale như 3 op kia nên xử lý chung kiểu adapter.
function adaptHistoryRoundReplay(r) {
  if (!r.ok) return r;
  const d = r.data || {};
  return {
    ok: true, status: 200,
    data: {
      ...d,
      totalWin: toMinor(d.totalWin),
      betAmount: toMinor(d.betAmount),
      timestamp: toEpochSecondsRaw(d.timestamp),
      wins: (d.wins || []).map((w) => ({ ...w, payout: toMinor(w.payout) })),
    },
  };
}

// SESSION_LIST không nằm trong 3 op được nêu, nhưng so sánh trực tiếp REST vs WS phát hiện cùng lỗi
// lệch scale: DebugController.listSessions() trả info.getBalance() thô (minor units), còn
// DebugCommandHandler.handleSessionList() gọi GrpcResponseMapper.toDisplayDouble() (display units).
function adaptSessionList(r) {
  if (!r.ok) return r;
  const d = r.data || {};
  const sessions = (d.sessions || []).map((s) => ({ ...s, balance: toMinor(s.balance) }));
  return { ok: true, status: 200, data: { count: d.count, sessions } };
}

function adaptJackpotLeaderboard(r, ctx) {
  if (!r.ok) return r;
  const d = r.data || {};
  const records = (d.history || []).map((row) => ({
    id: row.id, username: row.userName, date: row.date,
    amount: toMinor(row.amount), tier: row.jackpotType,
    gameId: ctx.q.get('gameId') || '', roundId: null, timestamp: null,
  }));
  return {
    ok: true, status: 200,
    data: {
      agency: ctx.q.get('agency') || '', gameId: ctx.q.get('gameId') || '', tiers: ['GRAND', 'MAJOR'],
      total: records.length, totalRecords: d.totalRecords, pageIndex: d.pageIndex, pageSize: d.pageSize,
      offset: d.offset, hasMore: d.hasMore, note: d.note, records,
    },
  };
}

/* ── Bảng (method, path) → (op, params) — cả 31 op debug ──────────────── */
/* Đường dẫn theo đúng @RequestMapping của 4 controller REST hiện có
   (DebugController /api/v1/debug, GameConfigController /api/v1/config,
   GameplayHistoryController /api/v1/gameplay-history, JackpotHistoryController
   /api/v1/jackpot) và args khớp đúng tên field DebugCommandHandler đọc. */
const WS_ROUTES = [
  // ── DebugController (21 op) ──
  { method: 'POST', re: /^\/api\/v1\/debug\/cheat\/([^/]+)\/([^/]+)$/, op: 'ARM_CHEAT',
    build: (m, q, body) => ({ agency: m[1], userId: m[2], args: body }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/cheat\/([^/]+)\/([^/]+)$/, op: 'PEEK_CHEAT',
    build: (m) => ({ agency: m[1], userId: m[2] }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/cheat-codes$/, op: 'CHEAT_CATALOG', build: () => ({}) },
  { method: 'POST', re: /^\/api\/v1\/debug\/session\/register$/, op: 'SESSION_REGISTER',
    build: (m, q, body) => ({ agency: body && body.agency, userId: body && body.userId, gameId: body && body.gameId, args: body }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/session\/list$/, op: 'SESSION_LIST', build: () => ({}), adapt: adaptSessionList },
  { method: 'GET', re: /^\/api\/v1\/debug\/session\/ws-list$/, op: 'SESSION_WS_LIST', build: () => ({}) },
  { method: 'GET', re: /^\/api\/v1\/debug\/session\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/, op: 'SESSION_GET',
    build: (m) => ({ agency: m[1], userId: m[2], gameId: m[3] }) },
  { method: 'DELETE', re: /^\/api\/v1\/debug\/session\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/, op: 'SESSION_DELETE',
    build: (m) => ({ agency: m[1], userId: m[2], gameId: m[3], args: { sessionId: m[4] } }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/session\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/force-mode$/, op: 'SESSION_FORCE_MODE',
    build: (m, q, body) => ({ agency: m[1], userId: m[2], gameId: m[3], args: { sessionId: m[4], mode: body && body.mode } }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/wallet\/([^/]+)\/([^/]+)$/, op: 'WALLET_GET',
    build: (m) => ({ agency: m[1], userId: m[2] }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/wallet\/([^/]+)\/([^/]+)$/, op: 'WALLET_SET',
    build: (m, q, body) => ({ agency: m[1], userId: m[2], args: body }) },
  { method: 'DELETE', re: /^\/api\/v1\/debug\/wallet\/([^/]+)\/([^/]+)$/, op: 'WALLET_RESET',
    build: (m) => ({ agency: m[1], userId: m[2] }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/bulk-buy\/([^/]+)\/([^/]+)$/, op: 'BULK_BUY_DEBUG',
    build: (m, q, body) => ({ agency: m[1], userId: m[2], gameId: body && body.gameId, args: body }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/history\/bulk-generate$/, op: 'HISTORY_BULK_GENERATE',
    build: (m, q) => ({ agency: q.get('agency'), userId: q.get('userId'), gameId: q.get('gameId'), args: { count: q.get('count') } }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/jackpot-history\/bulk-generate$/, op: 'JACKPOT_HISTORY_BULK_GENERATE',
    build: (m, q) => ({ agency: q.get('agency'), gameId: q.get('gameId'), args: { count: q.get('count') } }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/jackpot\/([^/]+)\/([^/]+)\/pools$/, op: 'JACKPOT_POOLS_GET',
    build: (m) => ({ agency: m[1], gameId: m[2] }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/jackpot\/([^/]+)\/([^/]+)\/pools$/, op: 'JACKPOT_POOLS_SET',
    build: (m, q, body) => ({ agency: m[1], gameId: m[2], args: body }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/jackpot\/([^/]+)\/([^/]+)\/seed$/, op: 'JACKPOT_SEED',
    build: (m) => ({ agency: m[1], gameId: m[2] }) },
  { method: 'DELETE', re: /^\/api\/v1\/debug\/jackpot\/([^/]+)\/([^/]+)\/pools$/, op: 'JACKPOT_POOLS_RESET',
    build: (m) => ({ agency: m[1], gameId: m[2] }) },
  { method: 'POST', re: /^\/api\/v1\/debug\/treasure-room\/([^/]+)\/([^/]+)$/, op: 'ARM_TREASURE_ROOM',
    build: (m, q) => ({ agency: m[1], userId: m[2], gameId: q.get('gameId') }) },
  { method: 'GET', re: /^\/api\/v1\/debug\/wsproxy\/status$/, op: 'WSPROXY_STATUS', build: () => ({}) },

  // ── GameConfigController (6 op) ──
  { method: 'GET', re: /^\/api\/v1\/config$/, op: 'CONFIG_LIST', build: () => ({}) },
  { method: 'GET', re: /^\/api\/v1\/config\/([^/]+)\/full$/, op: 'CONFIG_FULL', build: (m) => ({ gameId: m[1] }) },
  { method: 'POST', re: /^\/api\/v1\/config\/save$/, op: 'CONFIG_SAVE', build: (m, q, body) => ({ args: body }) },
  { method: 'DELETE', re: /^\/api\/v1\/config\/([^/]+)$/, op: 'CONFIG_DELETE', build: (m) => ({ gameId: m[1] }) },
  { method: 'POST', re: /^\/api\/v1\/config\/reload$/, op: 'CONFIG_RELOAD_ALL', build: () => ({}) },
  { method: 'POST', re: /^\/api\/v1\/config\/reload\/([^/]+)$/, op: 'CONFIG_RELOAD_ONE', build: (m) => ({ gameId: m[1] }) },

  // ── GameplayHistoryController (3 op) — data khác REST body, cần adapter ──
  { method: 'GET', re: /^\/api\/v1\/gameplay-history\/rounds$/, op: 'HISTORY_ROUNDS',
    build: (m, q) => ({ agency: q.get('agency'), userId: q.get('userId'), gameId: q.get('gameId'), args: { limit: q.get('limit'), offset: q.get('offset') } }),
    adapt: adaptHistoryRounds },
  { method: 'GET', re: /^\/api\/v1\/gameplay-history\/rounds\/([^/]+)\/replay$/, op: 'HISTORY_ROUND_REPLAY',
    build: (m, q) => ({ agency: q.get('agency'), args: { roundId: m[1] } }),
    adapt: adaptHistoryRoundReplay },
  { method: 'GET', re: /^\/api\/v1\/gameplay-history\/rounds\/([^/]+)$/, op: 'HISTORY_ROUND_DETAIL',
    // BE's delegateHistoryOp() đòi cả agency LẪN userId (dùng chung validation với HISTORY_ROUNDS) dù
    // REST /rounds/{roundId} chỉ cần agency — xem currentUserId() ở trên.
    build: (m, q) => ({ agency: q.get('agency'), userId: currentUserId(q), args: { roundId: m[1] } }),
    adapt: adaptHistoryRoundDetail },

  // ── JackpotHistoryController (1 op) — data khác REST body, cần adapter ──
  { method: 'GET', re: /^\/api\/v1\/jackpot\/history$/, op: 'JACKPOT_LEADERBOARD',
    build: (m, q) => ({ agency: q.get('agency'), userId: q.get('userId'), gameId: q.get('gameId'),
      args: { limit: q.get('limit'), offset: q.get('offset'), pageIndex: q.get('pageIndex'), pageSize: q.get('pageSize') } }),
    adapt: adaptJackpotLeaderboard },
];

function splitPathAndQuery(path) {
  const i = path.indexOf('?');
  return i === -1
    ? { p: path, q: new URLSearchParams() }
    : { p: path.slice(0, i), q: new URLSearchParams(path.slice(i + 1)) };
}

function matchWsRoute(method, path) {
  const { p, q } = splitPathAndQuery(path);
  for (const route of WS_ROUTES) {
    if (route.method !== method) continue;
    const m = route.re.exec(p);
    if (m) return { route, m, q };
  }
  return null;
}

/**
 * Điểm vào duy nhất mà call() (index.html) gọi ở chế độ WS.
 * Trả về {ok, status, data} nếu path map được 1 op; trả về null nếu không
 * map được (VD 3 tab endpoint chết, hoặc host agency-platform khác) — khi
 * đó call() tự rơi về fetch REST như cũ.
 */
async function wsDebugCall(method, path, body) {
  const hit = matchWsRoute(method, path);
  if (!hit) return null;
  const { route, m, q } = hit;
  const params = route.build(m, q, body || {});
  const result = await wsDebugExec(route.op, params);
  return route.adapt ? route.adapt(result, { m, q, args: params.args || {} }) : result;
}

if (hasDom()) {
  document.addEventListener('DOMContentLoaded', restoreWsConfig);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    wsDebugCall, matchWsRoute, WS_ROUTES, ensureToolWs, resetToolWs, wsDebugExec, toMinor,
    adaptHistoryRounds, adaptHistoryRoundDetail, adaptHistoryRoundReplay, adaptJackpotLeaderboard,
  };
}

/* ════════════════════════════════════════════════════════════════
   ws-debug.js — Đường truyền DUY NHẤT của cheatTool: mọi thao tác debug
   đi qua WebSocket cmd 1900. call() trong index.html gọi thẳng
   wsDebugCall() ở đây; path không map được op nào là lỗi lập trình
   (thiếu route trong WS_ROUTES), không còn đường REST để rơi xuống.

   Gồm:
     - toolWs: 1 NagaWsClient dùng chung cho mọi debug op, chỉ dựng được
       bằng nút "Kết nối" (AUTH+JOIN). KHÔNG nối ngầm và KHÔNG tự nối lại:
       rớt là xám hết nút gọi server cho tới khi QC bấm "Kết nối".
     - wsState + reportWsError: mọi lỗi đều nổi lên dải đỏ ở đầu trang
       (showWsError của index.html) VÀ hạ trạng thái xuống 'error' — kể cả
       khi socket còn mở và BE chỉ trả ok:false. Nhịp poll 5 giây lấy danh
       sách user vì thế cũng là thước đo sức khoẻ kết nối.
     - WS_ROUTES: bảng (method, path) → (op, params) cho cả 31 op debug.
     - 4 adapter cho các op có "data" khác khuôn cũ (đổi từ handler gRPC
       tái dùng thay vì controller cũ): HISTORY_ROUNDS, HISTORY_ROUND_DETAIL,
       HISTORY_ROUND_REPLAY, JACKPOT_LEADERBOARD.
     - UI glue: cấu hình WS URL/agentId/đăng nhập (localStorage),
       preset LOCAL/STAG, nút "Kết nối".

   Các mốc "REST ..." trong comment bên dưới nói về khuôn dữ liệu của
   controller REST cũ (đã xoá) — giữ lại vì chúng giải thích vì sao các
   adapter phải nắn dữ liệu như hiện tại.
   ════════════════════════════════════════════════════════════════ */

// DBG_TOKEN và gameId() là global của index.html, khai báo trong thẻ <script> đứng trước
// file này nên luôn sẵn sàng khi đoạn dưới chạy.
const DEBUG_TOKEN = DBG_TOKEN;

/* ── Cấu hình phiên WS của tool (WS URL / accessToken / agentId) ──────── */

const WS_CFG_LS = { url: 'naga_qc_ws_url', agent: 'naga_qc_ws_agent', user: 'naga_qc_ws_user', pass: 'naga_qc_ws_pass' };

// Giá trị lấy từ local_login.md và staging_login.md. Riêng tài khoản staging dùng Admin101 chứ
// không phải KOL-001 như trong tài liệu: đó là tài khoản riêng của tool, để tool không giành
// phiên với QC đang test (xem lý do ở comment 'local' ngay dưới — TokenRegistry khoá theo username).
// Local có seed token cố định nên không phải đăng nhập; staging phải qua luồng 2 bước.
const WS_PRESETS = {
  // Token 100 chứ không phải 001: TokenRegistry của BE khoá theo username, nên nếu tool JOIN trùng
  // danh tính với một người chơi thật thì nó GHI ĐÈ phiên của người đó — người chơi biến mất khỏi
  // danh sách và cheat nhắm vào họ cũng trượt. Dải 001-046 là của QC khi test tay, nên tool
  // lấy đuôi 100 cho khỏi đụng.
  local: { url: 'ws://localhost:9099/websocket', agent: '1', token: '1-valid-token-100' },
  stag: {
    url: 'wss://gob02-ws.relaxwmestu.xyz/websocket',
    agent: 'AGENCY_001',
    authHost: 'https://agency001.relaxwmestu.xyz',
    user: 'Admin101',
    pass: '12345',
  },
};

function wsCfgRaw(key) {
  const el = document.getElementById('i-ws-' + key);
  return el ? el.value.trim() : '';
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

// Cấu hình WS chỉ dùng một lần mỗi phiên. Nối xong thì thu lại thành chip cho gọn đầu trang;
// bấm chip là mở lại.
let wsCfgCollapsed = false;

/* ── Trạng thái kết nối — nguồn sự thật cho nút cheat và dải lỗi ──────── */

// 'idle' chưa nối lần nào · 'connecting' đang nối · 'connected' đã AUTH+JOIN · 'error' hỏng/rớt
let wsState = 'idle';

function wsConnected() { return wsState === 'connected'; }

function setWsState(state) {
  wsState = state;
  applyGating();  // index.html: xám/sáng mọi nút [data-needs-ws] / [data-needs-user]
  const btn = document.getElementById('btn-ws-connect');
  if (btn) {
    btn.textContent = state === 'connecting' ? 'Đang nối…' : (state === 'connected' ? 'Đã nối ✓' : 'Kết nối');
    btn.disabled = state === 'connecting';
  }
  // Nối xong thì hàng cấu hình tự thu lại, tức nút "Kết nối" bị ẩn. Mất kết nối mà cứ để thu
  // thì QC không còn đường nào bấm nối lại — phải bung ra.
  if (state !== 'connected' && state !== 'connecting' && wsCfgCollapsed) expandWsConfig();
}

/** Đẩy 1 lỗi lên dải đỏ đầu trang. Mọi đường lỗi của tool đều đi qua đây. */
function reportWsError(title, message, extra) {
  const lines = [];
  if (extra) lines.push(extra);
  lines.push('WS URL: ' + wsCfgUrl());
  showWsError({ title, message: String(message), detail: lines.join('\n') });
}

function applyWsRowVisibility() {
  const row = document.getElementById('ws-cfg-row');
  const sum = document.getElementById('ws-summary');
  // Lưu ý về việc chiếm phiên chỉ có nghĩa khi nút "Kết nối" đang hiện — bám theo cùng hàng.
  const note = document.getElementById('ws-note');
  if (row) row.style.display = wsCfgCollapsed ? 'none' : '';
  if (sum) sum.style.display = wsCfgCollapsed ? 'inline-flex' : 'none';
  if (note) note.style.display = wsCfgCollapsed ? 'none' : '';
}

function expandWsConfig() {
  wsCfgCollapsed = false;
  applyWsRowVisibility();
}

// Chip là <div role="button"> nên phải tự nhận Enter/Space, <button> thật thì trình duyệt lo sẵn.
function wsSummaryKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  expandWsConfig();
}

function saveWsConfig() {
  Object.keys(WS_CFG_LS).forEach((k) => {
    const el = document.getElementById('i-ws-' + k);
    if (el) localStorage.setItem(WS_CFG_LS[k], el.value.trim());
  });
  resetToolWs(); // cấu hình đổi -> phiên cũ (nếu có) không còn hợp lệ, phải bấm "Kết nối" lại
  setWsState('idle'); // nhãn "Đã nối ✓" của phiên vừa bị huỷ sẽ nói dối nếu để nguyên
  stopPoll();
  updateWsAuthVisibility(); // gõ tay URL sang staging cũng phải hiện ô đăng nhập
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
  Object.keys(WS_CFG_LS).forEach((k) => {
    const el = document.getElementById('i-ws-' + k);
    if (el) el.value = localStorage.getItem(WS_CFG_LS[k]) || WS_CFG_DEFAULTS[k] || '';
  });
  applyWsRowVisibility();
  updateWsAuthVisibility();
}

// Local không cần đăng nhập nên ẩn hẳn username/password — bớt thứ gây phân tâm và bớt cơ hội
// QC tưởng phải điền mới chạy được.
function updateWsAuthVisibility() {
  const display = wsIsLocal() ? 'none' : '';
  ['i-ws-user', 'i-ws-pass'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  });
}

function setWsPreset(which) {
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

// Hai lỗi hay gặp nhất khi đăng nhập staging đều từng hiện ra dưới dạng khó hiểu: fetch() nổ
// "Failed to fetch" (mạng/CORS/host sai) và res.json() nổ "Unexpected token <" khi server trả
// trang HTML lỗi. Bọc lại để câu lỗi nói đúng chuyện gì đã xảy ra ở đâu.
async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Không gọi được ' + url + ' — ' + e.message + ' (mạng, CORS hoặc host sai)');
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { res, data };
}

// Luồng 2 bước của agency-platform theo staging_login.md: /user/login lấy token tài khoản, rồi
// /play-game đổi sang token game — chính token game mới dùng để AUTH vào WebSocket.
// Host này là nền tảng của khách hàng, không phải game backend, nên gọi HTTP ở đây là đúng và
// không đi ngược mục tiêu bỏ REST vào game BE.
async function stagLogin() {
  const host = WS_PRESETS.stag.authHost;

  const loginUrl = host + '/api/v1/user/login';
  const login = await postJson(loginUrl, {}, { username: wsCfgUser(), password: wsCfgPass() });
  const loginToken = login.data && (login.data.token || (login.data.data && login.data.data.token));
  if (!login.res.ok || !loginToken) {
    throw new Error('Đăng nhập thất bại · HTTP ' + login.res.status + ' POST ' + loginUrl
      + ' · ' + JSON.stringify(login.data));
  }

  const playUrl = host + '/api/v1/play-game';
  const play = await postJson(playUrl, { Authorization: 'Bearer ' + loginToken }, { gameId: gameId() });
  const gameToken = play.data && (play.data.token || (play.data.data && play.data.data.token));
  if (!play.res.ok || !gameToken) {
    throw new Error('play-game thất bại · HTTP ' + play.res.status + ' POST ' + playUrl
      + ' · ' + JSON.stringify(play.data));
  }
  return gameToken;
}

/** Token để AUTH: local dùng seed cố định, staging đăng nhập lấy về (có nhớ lại trong phiên). */
async function resolveWsToken(forceRefresh) {
  if (wsIsLocal()) return WS_PRESETS.local.token;
  if (stagToken && !forceRefresh) return stagToken;
  stagToken = await stagLogin();
  return stagToken;
}

/** Nút "Kết nối": dựng phiên WS theo local_login.md / staging_login.md —
 *  mở WebSocket → AUTH (frame 1) → JOIN (cmd 1005). Đây là ĐƯỜNG DUY NHẤT tạo phiên:
 *  không bấm nút này thì mọi nút gọi server đều xám. */
async function wsConnect() {
  setWsState('connecting');
  try {
    // Bấm lại là nối lại từ đầu: bỏ cả token staging đang nhớ trong phiên, để token hết hạn
    // (~1 giờ) được đăng nhập lấy mới — đây là cách duy nhất làm mới token mà không phải F5.
    resetToolWs();
    stagToken = null;
    const client = await openToolWs();
    setWsState('connected');
    clearWsError();  // dải đỏ của lần hỏng trước không còn đúng nữa
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
      // Không nuốt lỗi: wsDebugExec đã vẽ dải đỏ và hạ trạng thái rồi, ở đây chỉ mất con số để khoe.
      found = null;
    }
    // Lấy danh sách hỏng nghĩa là mất kết nối — đừng khoe "Đã nối ✓" đè lên dải đỏ vừa hiện.
    if (!wsConnected()) return;

    startPoll(false);  // listSessions() vừa chạy ngay trên, chỉ cần bật nhịp 5 giây
    // Nối được rồi thì hàng cấu hình hết việc — thu lại, nhường chỗ cho vùng làm việc.
    const sum = document.getElementById('ws-summary');
    if (sum) {
      sum.innerHTML = '';
      sum.append('● ' + (wsIsLocal() ? 'WS local' : 'WS staging') + ' · ' + (j.userId || wsCfgAgent()));
      const edit = document.createElement('span');
      edit.className = 'ws-sum-edit';
      edit.textContent = 'sửa';
      sum.append(edit);
    }
    wsCfgCollapsed = true;
    applyWsRowVisibility();

    const msg = 'Đã kết nối WS · sessionId=' + client.sessionId + ' · ' + who
      + (found === null ? ' · không lấy được danh sách user' : ' · ' + found + ' user đang kết nối');
    if (typeof toast === 'function') toast(msg, 'success'); else console.log(msg);
  } catch (e) {
    setWsState('error');
    reportWsError('Kết nối WS thất bại', e.message);
    if (typeof toast === 'function') toast('Kết nối WS thất bại — chi tiết ở dải đỏ đầu trang', 'error');
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

// Seed token local theo quy ước có sẵn của BE: '1-valid-token-NNN' ↔
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
}

/** Rớt ngoài ý muốn. Không tự nối lại: lệnh đang bay có thể đã tới server, nối lại rồi gửi lại
 *  là làm thêm một lần thật (sinh dữ liệu, quay spin, trừ tiền). Xám nút và để QC quyết. */
function onToolWsDropped(closeInfo) {
  setWsState('error');
  stopPoll();
  // Rớt mạng thì việc cần làm luôn giống hệt nhau, nên chỉ nói đúng việc đó. Mã đóng và
  // WS URL vẫn nằm nguyên trong nút Copy để gửi dev khi cần dò.
  showWsError({
    title: 'Mất kết nối, vui lòng bấm Kết nối lại lần nữa',
    hidden: describeClose(closeInfo) + '\nWS URL: ' + wsCfgUrl(),
  });
}

/** Dựng phiên WS mới: mở socket → AUTH → JOIN. CHỈ nút "Kết nối" được gọi hàm này. */
async function openToolWs() {
  const token = await resolveWsToken(false);
  const client = new NagaWsClient({ url: wsCfgUrl(), onDisconnect: onToolWsDropped });
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
}

/** Trả về phiên đang mở. KHÔNG tự nối: nối ngầm thì QC không biết mình đang bắn lệnh vào
 *  môi trường nào, và một cheat đi nhầm sang staging là mất thời gian của cả team đi dò. */
function ensureToolWs() {
  // Xét cả wsState: một lệnh lỗi là hạ trạng thái xuống 'error' dù socket còn mở, và khi đó
  // tool phải im cho tới khi nối lại — nếu không, nút thì xám mà lệnh vẫn lọt qua được.
  if (!wsConnected() || !wsIsOpen(toolWs)) throw new Error('Chưa kết nối WS — bấm "Kết nối" ở thanh trên');
  return toolWs;
}

/** Gọi 1 debug op, trả về {ok, status, data} — cùng khuôn REST call() để renderer không đổi. */
async function wsDebugExec(op, params) {
  try {
    const client = ensureToolWs();
    return { ok: true, status: 200, data: await client.debug(op, { token: DEBUG_TOKEN, ...params }, 8000) };
  } catch (e) {
    const msg = String(e.message || e);
    // Lệnh nào lỗi cũng coi là mất kết nối — kể cả khi socket còn mở và BE chỉ trả ok:false.
    // Quy tắc một chiều như vậy để QC không phải đoán: nút xám nghĩa là bấm "Kết nối".
    setWsState('error');
    stopPoll();
    // Timeout KHÔNG có nghĩa là lệnh chưa chạy — reply có thể mất trong khi server đã thực thi
    // xong. Với HISTORY_BULK_GENERATE, BULK_BUY_DEBUG… bấm lại là sinh thêm một lô dữ liệu và
    // trừ tiền thật lần nữa, nên phải cảnh báo trước khi QC bấm lại.
    const mayHaveRun = msg.startsWith('Timeout');
    reportWsError('Lệnh ' + op + ' thất bại', msg,
      (mayHaveRun ? 'Không nhận được trả lời, nhưng lệnh có thể ĐÃ chạy ở server — kiểm tra kết quả trước khi bấm lại.\n' : '')
      + 'Tool đã ngắt kết nối — bấm "Kết nối" để dựng phiên mới.');
    return { ok: false, status: 0, data: { error: msg } };
  }
}

/* ── Tiện ích số tiền: WS trả display units, REST trả minor units (cent) ── */
function toMinor(display) {
  if (display === null || display === undefined) return display;
  const n = Number(display);
  return isNaN(n) ? display : Math.round(n * 100);
}

// Controller REST cũ serialize Instant thành số giây-epoch có phần thập phân (Jackson mặc định);
// WS (SpinListHandler/SpinDetailHandler) trả chuỗi ISO-8601. Adapter quy về số giây để giữ đúng
// khuôn dữ liệu mà phần render lịch sử vẫn đang mong đợi.
function toEpochSecondsRaw(iso) {
  if (!iso) return iso;
  const t = Date.parse(iso);
  return isNaN(t) ? iso : t / 1000;
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
/* Đường dẫn giữ nguyên theo @RequestMapping của 4 controller REST cũ (nay đã xoá)
   (DebugController /api/v1/debug, GameConfigController /api/v1/config,
   GameplayHistoryController /api/v1/gameplay-history, JackpotHistoryController
   /api/v1/jackpot) và args khớp đúng tên field DebugCommandHandler đọc. */
const WS_ROUTES = [
  // ── DebugController (21 op) ──
  // ARM_CHEAT bắt buộc mang gameId: BE validate lưới của FORCE_FREESPIN_SEQUENCE và
  // FORCE_WIN_STREAK_SEQUENCE theo bảng symbol của game, và tra GameRegistry bằng gameId
  // null thì nổ NPE (backing map là ConcurrentHashMap) chứ không trả lỗi tử tế.
  { method: 'POST', re: /^\/api\/v1\/debug\/cheat\/([^/]+)\/([^/]+)$/, op: 'ARM_CHEAT',
    build: (m, q, body) => ({ agency: m[1], userId: m[2], gameId: gameId(), args: body }) },
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
    // HISTORY_ROUND_DETAIL đi qua delegateHistoryOp ở BE — handler dùng chung với HISTORY_ROUNDS
    // nên đòi cả agency LẪN userId ở top-level, dù đường dẫn /rounds/{roundId} chỉ cần agency.
    build: (m, q) => ({ agency: q.get('agency'), userId: userId(), args: { roundId: m[1] } }),
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
 * Điểm vào duy nhất mà call() (index.html) gọi.
 * Trả về {ok, status, data} nếu path map được 1 op; trả về null nếu không
 * map được — call() biến null đó thành lỗi tường minh cho người dùng.
 */
async function wsDebugCall(method, path, body) {
  const hit = matchWsRoute(method, path);
  if (!hit) return null;
  const { route, m, q } = hit;
  const params = route.build(m, q, body || {});
  const result = await wsDebugExec(route.op, params);
  return route.adapt ? route.adapt(result, { m, q, args: params.args || {} }) : result;
}

document.addEventListener('DOMContentLoaded', () => {
  restoreWsConfig();
  setWsState('idle');  // mở trang là chưa nối: xám sẵn mọi nút gọi server
});

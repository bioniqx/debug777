/* ════════════════════════════════════════════════════════════════
   NagaWsClient — WebSocket client cho wsproxy, dùng bởi ws-debug.js.

   Giao thức frame (xem WEBSOCKET_GUIDE.md):
     C→S  AUTH  : [1, zone, "", "", {accessToken, agentId, reconnect}]
     S→C  AUTH  : [1, ok(bool), code, sessionId, zone, extra]
     C→S  CMD   : [6, zone, plugin, {cmd, ...}]
     S→C  PUSH  : {cmd, ...}            (object trần — kết quả spin 1700…)
                  [5, {cmd, ...}]       (push bọc — broadcast 9001, profile…)
     S→C  ERROR : [0, ...]
   ════════════════════════════════════════════════════════════════ */

/* Trình duyệt không cho JS đọc lý do thật của onerror (chặn vì lý do bảo mật), nên close code
   là manh mối DUY NHẤT để biết vì sao rớt — phải giữ lại và dịch ra tiếng người. */
const WS_CLOSE_TEXT = {
  1000: 'đóng bình thường',
  1001: 'phía kia rời đi',
  1005: 'không có mã đóng',
  1006: 'đóng bất thường — mất mạng hoặc server chết',
  1011: 'server gặp lỗi',
  1015: 'bắt tay TLS thất bại',
};

function describeClose(c) {
  if (!c) return '';
  return 'close ' + c.code + ' (' + (WS_CLOSE_TEXT[c.code] || 'không rõ') + ')'
    + (c.reason ? ' · ' + c.reason : '');
}

class NagaWsClient {
  constructor(opts = {}) {
    this.url = opts.url;
    this.zone = opts.zone || 'MiniGame';
    this.plugin = opts.plugin || 'game-naga-fortune-777';
    this.onLog = opts.onLog || null;   // fn(dir, frame) — tùy chọn
    this.ws = null;
    this.sessionId = null;             // lấy từ AUTH reply
    this.inbox = [];                   // message đã normalize, chưa được consume
    this.waiters = [];                 // {match, resolve, reject, timer, label}
    this.frames = [];                  // transcript đầy đủ {dir, at, frame}
    this.intendedClose = false;
    this.opened = false;               // đã onopen ít nhất một lần
    this.lastClose = null;             // {code, reason, wasClean} của lần đóng gần nhất
    this.onDisconnect = opts.onDisconnect || null;  // fn(closeInfo) — chỉ gọi khi rớt ngoài ý muốn
  }

  /* ── Kết nối ──────────────────────────────────────────────── */

  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('Timeout mở WebSocket ' + this.url), timeoutMs);
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        clearTimeout(timer);
        return fail('Không mở được WebSocket: ' + e.message);
      }
      this.ws.onopen = () => {
        clearTimeout(timer);
        this.opened = true;
        if (!settled) { settled = true; resolve(); }
      };
      this.ws.onmessage = (ev) => this._onMessage(ev.data);
      // onerror KHÔNG reject ngay: theo chuẩn WebSocket, sau error luôn có close — và chỉ close
      // mới mang code/reason. Chốt lỗi ở đây là vứt mất đúng thứ QC cần đọc (ví dụ 1006 = server
      // chưa bật). Nếu close không tới thì đã có timer 6 giây đỡ.
      let sawError = false;
      this.ws.onerror = () => { sawError = true; };
      this.ws.onclose = (ev) => {
        clearTimeout(timer);
        this.lastClose = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
        const why = describeClose(this.lastClose);
        fail((sawError ? 'Không mở được WebSocket ' + this.url : 'WebSocket đóng trước khi mở xong') + ' · ' + why);
        this._flushWaiters('WebSocket đã đóng · ' + why);
        // Rớt SAU khi đã mở xong thì không còn ai đang await connect() để nhận lỗi — im lặng ở
        // đây là lý do tool cứ tưởng mình vẫn nối cho tới lệnh debug kế tiếp.
        if (this.opened && !this.intendedClose && this.onDisconnect) this.onDisconnect(this.lastClose);
      };
    });
  }

  close() {
    this.intendedClose = true;
    try { if (this.ws) this.ws.close(); } catch (e) { /* bỏ qua */ }
    this._flushWaiters('Client đã đóng kết nối');
  }

  /* ── Gửi ──────────────────────────────────────────────────── */

  sendRaw(frame) {
    const text = JSON.stringify(frame);
    this.frames.push({ dir: 'out', at: Date.now(), frame });
    if (this.onLog) this.onLog('out', frame);
    this.ws.send(text);
  }

  /** Gửi 1 command tới plugin game: payload là object {cmd, ...} */
  sendCmd(payload) {
    this.sendRaw([6, this.zone, this.plugin, payload]);
  }

  /* ── Luồng chuẩn: auth → join ─────────────────────────────── */

  /** Gửi AUTH, chờ reply [1, ok, code, sessionId, ...]. Trả về msg đã normalize. */
  async auth(accessToken, agentId, timeoutMs = 6000) {
    this.sendRaw([1, this.zone, '', '', { accessToken, agentId, reconnect: false }]);
    const msg = await this.waitFor((m) => m.kind === 'auth', timeoutMs, 'AUTH reply');
    if (!msg.ok) throw new Error('AUTH bị từ chối: ' + JSON.stringify(msg.raw));
    this.sessionId = msg.sessionId;
    return msg;
  }

  /** Gửi JOIN (cmd 1005), chờ push cmd 1005. Trả về payload join. */
  async join(username, userId, timeoutMs = 8000) {
    this.sendCmd({ cmd: 1005, username, userId, sessionId: this.sessionId });
    const msg = await this.waitFor(1005, timeoutMs, 'JOIN (cmd 1005) reply');
    return msg.payload;
  }

  /* ── Debug op (cmd 1900) — cheatTool dùng cho mọi thao tác debug ─── */

  /**
   * Gửi 1 debug op qua cmd 1900. params: {token, agency, userId, gameId, args}.
   * Trả về payload.data khi ok=true; throw Error(payload.error) khi ok=false.
   */
  async debug(op, params = {}, timeoutMs = 8000) {
    const reqId = 'dbg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    this.sendCmd({ cmd: 1900, op, reqId, ...params });
    const msg = await this.waitFor(
      (m) => m.cmd === 1900 && m.payload && m.payload.reqId === reqId,
      timeoutMs, 'DEBUG_OP ' + op);
    if (msg.payload.ok === false) throw new Error(msg.payload.error || ('DEBUG_OP ' + op + ' thất bại'));
    return msg.payload.data;
  }

  /* ── Nhận & chờ ───────────────────────────────────────────── */

  /**
   * Chờ message khớp điều kiện.
   *   match: number  → khớp msg.cmd === number
   *          fn(msg) → tự viết điều kiện (msg có {kind, cmd, payload, raw})
   * Mặc định message khớp sẽ bị lấy ra khỏi inbox (consume).
   * Trả về Promise<msg>; reject khi timeout hoặc socket đóng.
   */
  waitFor(match, timeoutMs = 8000, label = '') {
    const fn = (typeof match === 'number')
      ? (m) => m.cmd === match
      : match;
    // Có sẵn trong inbox thì trả luôn
    const idx = this.inbox.findIndex(fn);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter = { fn, resolve, reject, label };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('Timeout ' + (timeoutMs / 1000) + 's chờ ' + (label || 'message')));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Tiện: chờ reply cmd HOẶC error frame — dùng cho case guard (kỳ vọng bị từ chối). */
  waitForCmdOrError(cmd, timeoutMs = 8000, label = '') {
    return this.waitFor(
      (m) => m.cmd === cmd || m.kind === 'error' || (m.payload && m.payload.error !== undefined),
      timeoutMs,
      label || ('cmd ' + cmd + ' hoặc error')
    );
  }

  /* ── Nội bộ ───────────────────────────────────────────────── */

  _onMessage(data) {
    if (typeof data !== 'string') return; // wsproxy chỉ gửi text frame
    let frame;
    try { frame = JSON.parse(data); } catch (e) { return; }
    this.frames.push({ dir: 'in', at: Date.now(), frame });
    if (this.onLog) this.onLog('in', frame);
    const msg = this._normalize(frame);
    // Đưa cho waiter đầu tiên khớp, không thì xếp vào inbox
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      let hit = false;
      try { hit = w.fn(msg); } catch (e) { hit = false; }
      if (hit) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    this.inbox.push(msg);
  }

  _normalize(frame) {
    if (Array.isArray(frame)) {
      const t = frame[0];
      if (t === 1) {
        return { kind: 'auth', ok: frame[1] === true, code: frame[2], sessionId: frame[3], cmd: null, payload: null, raw: frame };
      }
      if (t === 5) {
        const p = frame[1];
        // cmd có thể là số (push ZMQ) hoặc chuỗi (reply gRPC) → quy về số
        const c = p && p.cmd !== undefined ? Number(p.cmd) : undefined;
        return { kind: 'push', cmd: isNaN(c) ? undefined : c, payload: p, raw: frame };
      }
      if (t === 0) {
        return { kind: 'error', cmd: null, payload: frame, raw: frame };
      }
      return { kind: 'other', cmd: null, payload: frame, raw: frame };
    }
    if (frame && typeof frame === 'object') {
      const c = frame.cmd !== undefined ? Number(frame.cmd) : undefined;
      return { kind: 'push', cmd: isNaN(c) ? undefined : c, payload: frame, raw: frame };
    }
    return { kind: 'other', cmd: null, payload: frame, raw: frame };
  }

  _flushWaiters(reason) {
    const pending = this.waiters;
    this.waiters = [];
    pending.forEach((w) => {
      clearTimeout(w.timer);
      if (!this.intendedClose) w.reject(new Error(reason));
      else w.reject(new Error('Kết nối đã được đóng chủ động'));
    });
  }
}

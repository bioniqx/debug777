/* ════════════════════════════════════════════════════════════════
   TEST_CATALOG — registry các test case happy (Phần A, ưu tiên Cao)
   + TCH: helper nghiệp vụ dùng chung cho mọi case.

   Mỗi case đăng ký bằng:
     TEST_CATALOG.register({
       id: 'TC-SPIN-02', group: 'SPIN', title: '…',
       mode: 'AUTO',              // AUTO | SKIP
       skipReason: '…',           // bắt buộc khi mode SKIP
       async run(ctx) { … }       // ném lỗi hoặc ghi ctx.A.failures → FAIL
     });

   ctx do test-runner.js cấp: { user, ws, api, A, cfg, log }
   ════════════════════════════════════════════════════════════════ */

const TEST_CATALOG = {
  cases: [],

  register(def) {
    if (!def || !def.id || !def.group || !def.title) {
      throw new Error('Case đăng ký thiếu id/group/title: ' + JSON.stringify(def));
    }
    if (def.mode !== 'SKIP' && typeof def.run !== 'function') {
      throw new Error(def.id + ': case AUTO phải có hàm run(ctx)');
    }
    if (this.cases.some((c) => c.id === def.id)) {
      throw new Error('Trùng case id: ' + def.id);
    }
    this.cases.push(Object.assign({ mode: 'AUTO' }, def));
  },

  groups() {
    const seen = [];
    this.cases.forEach((c) => { if (!seen.includes(c.group)) seen.push(c.group); });
    return seen;
  },

  get(id) { return this.cases.find((c) => c.id === id); },
};

/* ── Luật game dùng cho assertion ─────────────────────────────────
   Nguồn: game-naga-fortune-777.yaml + BetWhitelist + TEST_CASES.md.
   Mọi con số tập trung ở đây để đối chiếu/sửa một chỗ.            */
const TC_RULES = {
  lines: 5,                       // số payline cố định (BetWhitelist.LINES)
  betFormula: (coinPerLine, coinValue) => coinPerLine * coinValue * 5,
  coinValues: [1, 5, 20, 50, 100, 200, 500],   // id = String(value)
  coinPerLineMax: 10,             // betLevelId "1".."10" = coinPerLine
  // Trần thắng theo GDD/TEST_CASES = 2000×bet, NHƯNG engine hiện trả
  // res.winCap = 20000×bet (rtp.winCap trong YAML) — TC-SPIN-08 assert cả hai
  // để lộ mismatch cho team quyết.
  winCapMultiplierGdd: 2000,

  // paytable[3-of-a-kind] theo symbolId; linePay = pay × coinPerLine × coinValue
  pay: { 1: 200, 2: 50, 3: 25, 4: 15, 5: 10 },   // A, B, C, D, E
  // 3×Wild trên 1 đường: override theo payline (× coinPerLine × coinValue)
  wildPaylinePay: { P01: 1000, P02: 2000, P03: 3000, P04: 6000, P05: 4000 },
  comboBCD: 8,                    // B+C+D (id 2+3+4) cùng đường, mọi thứ tự
  symbols: { A: 1, B: 2, C: 3, D: 4, E: 5, WILD: 10, BLANK: 0, NAGA_EYE: 11 },
  // screen.symbols trả về MẢNG PHẲNG 9 chữ cái theo code:
  symbolCode: { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E', 10: 'W', 0: 'Q', 11: 'J' },

  // Cuộn 4: mỗi hàng 1 hệ số trong {1,2,5,10}; đường thắng nhân theo HÀNG KẾT THÚC
  fourthReelMults: [1, 2, 5, 10],
  paylineEndRow: { P01: 1, P02: 0, P03: 2, P04: 2, P05: 0 },

  rushEnergyTarget: 30,           // đủ 30 lượt thua → 5 free spin
  rushFreeSpins: 5,
  streakRequired: 3,              // 3 ván thắng liên tiếp → 1 Special Free Spin
  secondChoiceCostMult: 1,        // chi phí respin reel 3 = 1 × baseBet
  vaultCost: { BRONZE: 15, SILVER: 30, GOLD: 100 },   // × totalBet
  vaultMaxDoubleUp: 3,
  bulkPacks: {                    // packType đúng chuỗi gửi qua cmd 1511
    MULTI_PACK:       { spins: 10, costMult: 8 },
    SUPER_MULTI_PACK: { spins: 55, costMult: 40 },
  },
};

/* ── TCH: helper nghiệp vụ ───────────────────────────────────── */
const TCH = {

  /** Mở WS → AUTH → JOIN, rồi XẢ session về BASE mode.
      User pool tái sử dụng giữa các lần chạy nên có thể dính free spin /
      bulk còn treo từ lượt trước → spin không trừ bet làm sai assertion. */
  async connectJoin(ctx) {
    await ctx.ws.connect(ctx.cfg.timeoutMs);
    await ctx.ws.auth(ctx.user.token, ctx.user.agentId, ctx.cfg.timeoutMs);
    ctx.joined = await ctx.ws.join(ctx.user.username, ctx.user.userId, ctx.cfg.timeoutMs);
    ctx._mode = ctx.joined.currentMode || 'BASE';
    ctx._bulkRemain = TCH.num(ctx.joined.bulkSpinsRemaining) || 0;
    await TCH.drainToBase(ctx);
    return ctx.joined;
  },

  /** Chơi hết các spin treo (free spin / bulk) cho tới khi về BASE mode.
      Dựa trên mode sống do TCH.spin theo dõi (round.nextMode). */
  async drainToBase(ctx, maxSpins) {
    const max = maxSpins || 60;
    let n = 0;
    while ((ctx._mode !== 'BASE' || ctx._bulkRemain > 0) && n < max) {
      await TCH.spin(ctx, 1, 1, 12000);
      n++;
    }
    if (n > 0) ctx.log('drainToBase: đã chơi ' + n + ' spin treo để về BASE mode');
    return n;
  },

  /** Spin happy: gửi cmd 1500, chờ push kết quả — server ECHO cmd:1500
      (mọi push spin, kể cả buy-feature 1501, đều mang cmd 1500).
      Spin bị từ chối thì naga KHÔNG push gì (lỗi chỉ nằm trên kênh gRPC). */
  async spin(ctx, betLevelId, coinValueId, timeoutMs) {
    ctx.ws.sendCmd({ cmd: 1500, betLevelId: String(betLevelId), coinValueId: String(coinValueId) });
    return TCH.waitSpinResult(ctx, timeoutMs);
  },

  /** Chờ 1 push kết quả spin (cmd 1500 có screen). Dùng sau 1500/1501/1511… */
  async waitSpinResult(ctx, timeoutMs) {
    const msg = await ctx.ws.waitFor(
      (m) => m.cmd === 1500 && m.payload
        && (m.payload.screen !== undefined || m.payload.error !== undefined),
      timeoutMs || ctx.cfg.timeoutMs, 'push kết quả spin (cmd 1500)');
    if (msg.payload.error !== undefined) {
      throw new Error('Spin bị từ chối ngoài dự kiến: ' + TCH.errorCode(msg));
    }
    // Theo dõi mode sống cho drainToBase
    const nextMode = TCH.pick(msg.payload, 'round.nextMode');
    if (nextMode) ctx._mode = nextMode;
    const bulkRemain = TCH.pick(msg.payload, 'bulk.spinsRemaining');
    if (bulkRemain !== undefined) ctx._bulkRemain = TCH.num(bulkRemain) || 0;
    return msg.payload;
  },

  /**
   * Gửi payload kỳ vọng BỊ TỪ CHỐI. Hai hành vi thật của server:
   * - SPIN (cmd 1500/1501): từ chối là IM LẶNG — không push gì → silent:true.
   * - Cmd khác (1510/1513/1515…): push {cmd:<gốc>, error:"MÃ"}.
   * Trả về {rejected, silent, code, msg}; rejected=false nghĩa là lọt qua.
   */
  async expectReject(ctx, payload, windowMs) {
    ctx.ws.sendCmd(payload);
    try {
      const msg = await ctx.ws.waitFor(
        (m) => m.cmd === Number(payload.cmd) || m.kind === 'error',
        windowMs || 3000, 'phản hồi cmd ' + payload.cmd);
      return { rejected: TCH.isRejection(msg), silent: false, code: TCH.errorCode(msg), msg };
    } catch (e) {
      return { rejected: true, silent: true, code: '', msg: null };
    }
  },

  /** Arm cheat qua REST debug; ném lỗi nếu arm thất bại. */
  async arm(ctx, cheat, value) {
    const r = await ctx.api.armCheat(cheat, value || {});
    if (!r.ok) throw new Error('Arm cheat ' + cheat + ' thất bại: HTTP ' + r.status + ' ' + JSON.stringify(r.data));
    return r.data;
  },

  /** Set số dư qua REST debug wallet. */
  async setBalance(ctx, amount) {
    const r = await ctx.api.setBalance(amount);
    if (!r.ok) throw new Error('Set balance thất bại: HTTP ' + r.status + ' ' + JSON.stringify(r.data));
    return r.data;
  },

  /** Lấy số dư hiện tại qua cmd 1503. */
  async balance(ctx) {
    ctx.ws.sendCmd({ cmd: 1503 });
    const msg = await ctx.ws.waitFor(1503, ctx.cfg.timeoutMs, 'balance 1503');
    return TCH.num(msg.payload.balance);
  },

  /** Dựng screen 3×3 cho FORCE_GRID, dạng reel-major: cols[reel][row]. */
  gridCols(c1, c2, c3) { return [c1, c2, c3]; },

  /** Nhận diện phản hồi "bị từ chối" — error frame [0,...] hoặc {cmd, error:"MÃ"}. */
  isRejection(msg) {
    if (!msg) return false;
    if (msg.kind === 'error') return true;
    const p = msg.payload || {};
    return p.error !== undefined || p.errorCode !== undefined;
  },

  /** Mã lỗi của phản hồi từ chối ('' nếu không có). */
  errorCode(msg) {
    const p = (msg && msg.payload) || {};
    return String(p.error || p.errorCode || '');
  },

  /** Đọc hệ số cuộn 4 theo hàng [r0,r1,r2] từ kết quả spin; null nếu không đọc được. */
  fourthReelMults(res) {
    const fr = res && res.fourthReel;
    if (!fr || !Array.isArray(fr.symbols)) return null;
    const ms = fr.symbols.map((s) => {
      if (typeof s === 'number') return s;
      if (s && typeof s === 'object') {
        return TCH.num(s.multiplier !== undefined ? s.multiplier : s.value);
      }
      const n = parseFloat(String(s).replace(/^x/i, ''));
      return isFinite(n) ? n : NaN;
    });
    return ms.length === 3 && ms.every((n) => TC_RULES.fourthReelMults.includes(n)) ? ms : null;
  },

  /**
   * Assert totalWin = baseWin × hệ số cuộn 4 của hàng kết thúc payline.
   * Đọc được hệ số → assert chính xác; không đọc được → chấp nhận
   * baseWin × một trong {1,2,5,10} (cuộn 4 là ngẫu nhiên, không ép được
   * cùng lúc với FORCE_GRID — gap J1).
   */
  checkWinWithFourthReel(ctx, res, baseWin, paylineId, label) {
    const total = TCH.num(TCH.pick(res, 'balance.totalWin'));
    const endRow = TC_RULES.paylineEndRow[paylineId];
    const mults = TCH.fourthReelMults(res);
    if (mults && endRow !== undefined) {
      ctx.A.near(total, baseWin * mults[endRow],
        label + ' (×x' + mults[endRow] + ' cuộn 4 hàng ' + endRow + ')');
      return;
    }
    const okRatio = TC_RULES.fourthReelMults.some(
      (r) => Math.abs(total - baseWin * r) <= 0.005);
    ctx.A.ok(okRatio,
      label + ': totalWin ' + total + ' ≠ ' + baseWin + ' × {1,2,5,10}');
  },

  num(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  },

  /** Đọc field lồng nhau theo path 'a.b.c'; undefined nếu thiếu. */
  pick(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },

  /** So 2 screen.symbols (mảng phẳng 9 phần tử) → danh sách index khác nhau. */
  diffScreen(s1, s2) {
    const out = [];
    for (let i = 0; i < 9; i++) {
      if (!s1 || !s2 || s1[i] !== s2[i]) out.push(i);
    }
    return out;
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TEST_CATALOG, TCH, TC_RULES };
}

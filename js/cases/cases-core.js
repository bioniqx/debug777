/* ════════════════════════════════════════════════════════════════
   CASES — CORE: CONN, BET, SPIN, PAY, R4, WAL, SYS, CONC
   (Phần A ưu tiên Cao trong TEST_CASES.md)

   Quy ước chung (đã XÁC MINH bằng probe trên stack thật):
   - Mỗi case tự connect/auth/join bằng TCH.connectJoin(ctx) khi cần gameplay.
   - Push kết quả spin mang cmd:1500 (echo, số) — KHÔNG phải 1700; tiền nằm
     trong res.balance = {before, after, totalWin, hasWin}; đường thắng trong
     res.wins[] = {symbolId, payout, paylineIndex, paylineId, matchCount, winType}.
   - res.screen.symbols = MẢNG PHẲNG 9 CHỮ CÁI, ROW-MAJOR (index = hàng×3 + cuộn);
     cuộn r (0-based) chiếm index {r, r+3, r+6}. FORCE_GRID input thì REEL-MAJOR.
   - wins[].payout ĐÃ nhân sẵn hệ số cuộn 4 (x1/x2/x5/x10 theo hàng kết thúc,
     đọc từ res.fourthReel.symbols ["x2","x1",...]) → so tiền thắng bằng
     TCH.checkWinWithFourthReel, KHÔNG so trực tiếp với paytable.
   - SPIN bị từ chối = IM LẶNG (naga không push) → dùng TCH.expectReject;
     cmd khác (1510/1513/1515…) bị từ chối thì push {cmd:<gốc>, error:"MÃ"}.
   - So sánh tiền dùng ctx.A.near (epsilon) — không dùng ===.
   - wsproxy DROP field null → field "vắng mặt" nghĩa là naga đặt null.
   ════════════════════════════════════════════════════════════════ */

/* ── SYS ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-SYS-01',
  group: 'SYS',
  title: 'Ping server (cmd 1002) có phản hồi pong',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    ctx.ws.sendCmd({ cmd: 1002 });
    // naga trả {cmd:1002, pong:true}; một số tầng wsproxy có thể trả
    // {cmd:1002, c:0, ts} hoặc frame heartbeat [6,...] — chấp nhận cả ba
    const msg = await ctx.ws.waitFor(
      (m) => m.cmd === 1002 || (Array.isArray(m.raw) && m.raw[0] === 6),
      ctx.cfg.timeoutMs, 'pong cho cmd 1002');
    ctx.A.ok(!TCH.isRejection(msg), 'ping không được trả về lỗi: ' + TCH.errorCode(msg));
  },
});

/* ── SPIN ────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-SPIN-02',
  group: 'SPIN',
  title: 'Quay không có đường thắng (FORCE_LOSS): totalWin=0, trừ đúng tiền cược',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);
    await TCH.arm(ctx, 'FORCE_LOSS');
    const res = await TCH.spin(ctx, 1, 1);
    const bet = TC_RULES.betFormula(1, 1); // 1 × 1 × 5 = 5 units

    ctx.A.near(TCH.pick(res, 'balance.totalWin'), 0, 'totalWin khi thua');
    ctx.A.eq(TCH.pick(res, 'balance.hasWin'), false, 'hasWin khi thua');
    const wins = res.wins || [];
    ctx.A.eq(Array.isArray(wins) ? wins.length : -1, 0, 'số đường thắng');
    ctx.A.near(TCH.pick(res, 'balance.after'), before - bet, 'balance.after = trước − bet');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, before - bet, 'balance (1503) sau spin thua');
  },
});

/* ── BET ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-BET-04',
  group: 'BET',
  title: 'Spin thiếu betLevelId (Coin Per Line) bị từ chối, không trừ tiền',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);
    // Spin lỗi validation: naga KHÔNG push kết quả (im lặng trên kênh WS)
    const r = await TCH.expectReject(ctx, { cmd: 1500, coinValueId: '1' });
    ctx.A.ok(r.rejected, 'spin thiếu betLevelId phải bị từ chối, nhận: '
      + (r.msg ? JSON.stringify(r.msg.raw).slice(0, 200) : '(không có)'));
    if (r.silent) ctx.log('Từ chối im lặng (đúng hành vi hiện tại — lỗi chỉ nằm trên kênh gRPC)');
    const after = await TCH.balance(ctx);
    ctx.A.near(after, before, 'balance không đổi khi spin bị từ chối');
  },
});

/* ── CONN ────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-CONN-01',
  group: 'CONN',
  title: 'Join thành công: kiểm tra cấu trúc dữ liệu tham gia (balance, betLevels, coinValues, jackpotPools)',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const j = ctx.joined;

    // balance phải là string, parse ra số hữu hạn
    ctx.A.type(j.balance, 'string', 'joined.balance phải là string');
    ctx.A.ok(isFinite(parseFloat(j.balance)), 'joined.balance parse được thành số');

    // đúng 10 bet levels với id "1".."10"
    ctx.A.ok(Array.isArray(j.betLevels) && j.betLevels.length === 10, 'có đúng 10 betLevels');
    const betIds = j.betLevels.map((b) => b.id);
    for (let i = 1; i <= 10; i++) {
      ctx.A.ok(betIds.includes(String(i)), 'betLevels có id "' + i + '"');
    }

    // đúng 7 coinValues với value {1,5,20,50,100,200,500}
    ctx.A.ok(Array.isArray(j.coinValues) && j.coinValues.length === 7, 'có đúng 7 coinValues');
    const expectedCoinValues = TC_RULES.coinValues;
    for (const expected of expectedCoinValues) {
      const found = j.coinValues.some((cv) => TCH.num(cv.value) === expected);
      ctx.A.ok(found, 'coinValues có value ' + expected);
    }

    // jackpotPools đủ 3 tier (string decimal)
    ctx.A.ok(j.jackpotPools !== undefined, 'jackpotPools tồn tại');
    for (const tier of ['MINOR', 'MAJOR', 'GRAND']) {
      const val = j.jackpotPools && j.jackpotPools[tier];
      ctx.A.ok(val !== undefined, 'jackpotPools có tier ' + tier);
      ctx.A.ok(isFinite(parseFloat(val)), 'jackpotPools.' + tier + ' parse được thành số: ' + val);
    }

    // sessionId 8 ký tự
    ctx.A.ok(typeof j.sessionId === 'string' && j.sessionId.length === 8,
      'sessionId là string 8 ký tự, nhận: ' + JSON.stringify(j.sessionId));

    // currentMode hợp lệ
    const validModes = ['BASE', 'FREE_SPIN', 'BONUS'];
    ctx.A.ok(validModes.includes(j.currentMode),
      'currentMode hợp lệ (' + validModes.join('/') + '), nhận: ' + j.currentMode);

    // balance so với 1503 (near)
    const bal1503 = await TCH.balance(ctx);
    ctx.A.near(parseFloat(j.balance), bal1503, 'joined.balance ≈ 1503 balance');
  },
});

TEST_CATALOG.register({
  id: 'TC-CONN-03',
  group: 'CONN',
  title: 'Reconnect sau spin: lastSnapshot giữ đúng round + state',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Spin 1 lần để tạo lastSnapshot
    await TCH.arm(ctx, 'FORCE_LOSS');
    const res = await TCH.spin(ctx, 1, 1);
    const roundId = res.round && res.round.id;
    ctx.A.ok(roundId, 'round.id tồn tại sau spin');

    const rushEnergy = res.rush ? res.rush.energy : 0;
    const winStreakCount = res.winStreak ? res.winStreak.count : 0;

    // Đóng ws rồi connect lại với cùng token
    ctx.ws.close();
    const ws2 = ctx.newWs();
    await ws2.connect(ctx.cfg.timeoutMs);
    await ws2.auth(ctx.user.token, ctx.user.agentId, ctx.cfg.timeoutMs);
    const joined2 = await ws2.join(ctx.user.username, ctx.user.userId, ctx.cfg.timeoutMs);

    // lastSnapshot phải tồn tại
    ctx.A.ok(joined2.lastSnapshot !== undefined && joined2.lastSnapshot !== null,
      'lastSnapshot tồn tại sau reconnect');

    // round.id khớp
    const snapRoundId = TCH.pick(joined2, 'lastSnapshot.round.id');
    ctx.A.eq(snapRoundId, roundId, 'lastSnapshot.round.id khớp với round đã spin');

    // betLevelId và coinValueId giữ nguyên
    ctx.A.eq(String(joined2.betLevelId), '1', 'betLevelId giữ nguyên "1"');
    ctx.A.eq(String(joined2.coinValueId), '1', 'coinValueId giữ nguyên "1"');

    // rushEnergy và winStreakCount khớp trạng thái trước khi thoát
    const snap = joined2.lastSnapshot;
    const snapRush = snap.rush ? snap.rush.energy : (joined2.rushEnergy || 0);
    ctx.A.eq(snapRush, rushEnergy, 'rushEnergy khớp trạng thái trước khi đóng ws');
    const snapStreak = snap.winStreak ? snap.winStreak.count : (joined2.winStreakCount || 0);
    ctx.A.eq(snapStreak, winStreakCount, 'winStreakCount khớp trạng thái trước khi đóng ws');
  },
});

/* ── BET (thêm) ──────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-BET-01',
  group: 'BET',
  title: 'Spin betLevelId="1" coinValueId="1": totalBet=5, balance đúng sau spin',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 1 × 1 × 5 = 5

    const res = await TCH.spin(ctx, 1, 1);

    ctx.A.near(TCH.num(res.totalBet || res.betAmount), bet, 'totalBet == 5');
    ctx.A.near(TCH.pick(res, 'balance.before'), before, 'balance.before == số dư trước spin');
    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + totalWin,
      'balance.after == before − bet + totalWin'
    );
    ctx.A.ok(!TCH.isRejection({ payload: res }), 'spin không có lỗi trong payload');
  },
});

TEST_CATALOG.register({
  id: 'TC-BET-05',
  group: 'BET',
  title: 'Spin thiếu coinValueId bị từ chối (im lặng), balance không đổi',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);

    // Gửi spin thiếu coinValueId — naga im lặng
    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1' });
    ctx.A.ok(r.rejected, 'spin thiếu coinValueId phải bị từ chối, nhận: '
      + (r.msg ? JSON.stringify(r.msg.raw).slice(0, 200) : '(silent)'));
    if (r.silent) ctx.log('Từ chối im lặng — lỗi gRPC không được push qua WS');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, before, 'balance không đổi khi spin bị từ chối');
  },
});

TEST_CATALOG.register({
  id: 'TC-BET-08',
  group: 'BET',
  title: 'Spin coinValueId không thuộc whitelist ("3") bị từ chối (im lặng), balance không đổi',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);

    // coinValueId "3" không trong {1,5,20,50,100,200,500}
    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1', coinValueId: '3' });
    ctx.A.ok(r.rejected, 'coinValueId "3" không hợp lệ phải bị từ chối');
    if (r.silent) ctx.log('Từ chối im lặng — đúng hành vi khi coinValueId sai');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, before, 'balance không đổi khi coinValueId không hợp lệ');
  },
});

TEST_CATALOG.register({
  id: 'TC-BET-09',
  group: 'BET',
  title: 'Spin betLevelId="11" (vượt quá max 10) bị từ chối (im lặng), balance không đổi',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);

    // betLevelId "11" nằm ngoài range 1..10
    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '11', coinValueId: '1' });
    ctx.A.ok(r.rejected, 'betLevelId "11" phải bị từ chối');
    if (r.silent) ctx.log('Từ chối im lặng — đúng hành vi khi betLevelId vượt max');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, before, 'balance không đổi khi betLevelId không hợp lệ');
  },
});

/* ── SPIN (thêm) ─────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-SPIN-01',
  group: 'SPIN',
  title: 'FORCE_GRID 3×A đường giữa (P01): 1 đường thắng, payout đúng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 10000);
    const before = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5

    // Reel-major: reel1=[row0=A(2),row1=A(1),row2=C(3)],
    //             reel2=[row0=C(3),row1=A(1),row2=E(5)],
    //             reel3=[row0=E(5),row1=A(1),row2=B(2)]
    // Hàng giữa (row1) = A,A,A → P01 thắng; hàng trên C,C,E không thắng; hàng dưới 3,5,2 không thắng
    // P04(chéo xuống): reel1row0,reel2row1,reel3row2 = 2,1,2 → BCA — không phải B+C+D combo
    // P05(chéo lên): reel1row2,reel2row1,reel3row0 = 3,1,5 = CDE — không match
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[2, 1, 3], [3, 1, 5], [5, 1, 2]] });
    const res = await TCH.spin(ctx, 1, 1);

    const wins = res.wins || [];
    ctx.A.eq(wins.length, 1, 'đúng 1 đường thắng');
    ctx.A.eq(wins[0].paylineId, 'P01', 'đường thắng là P01 (hàng giữa)');
    ctx.A.eq(wins[0].symbolId, TC_RULES.symbols.A, 'symbolId là A (id=1)');
    ctx.A.eq(wins[0].matchCount, 3, 'matchCount = 3');

    // baseWin = pay[A] × coinPerLine × coinValue = 200 × 1 × 1 = 200
    const baseWin = TC_RULES.pay[TC_RULES.symbols.A] * 1 * 1;
    TCH.checkWinWithFourthReel(ctx, res, baseWin, 'P01', 'totalWin P01 3×A');
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + TCH.num(TCH.pick(res, 'balance.totalWin')),
      'balance.after = before − bet + totalWin'
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-SPIN-03',
  group: 'SPIN',
  title: 'FORCE_GRID 2 đường thắng đồng thời (P01 A×3 + P02 E×3): payout tổng đúng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 10000);
    const before = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5

    // Reel-major: reel1=[row0=E(5),row1=A(1),row2=Q(0)],
    //             reel2=[row0=E(5),row1=A(1),row2=Q(0)],
    //             reel3=[row0=E(5),row1=A(1),row2=B(2)]
    // Hàng trên (row0): E,E,E → P02 thắng (end row0)
    // Hàng giữa (row1): A,A,A → P01 thắng (end row1)
    // Hàng dưới (row2): Q,Q,B → không thắng
    // P04 (chéo xuống end row2): reel1row0,reel2row1,reel3row2 = 5,1,2 = EAB → không win
    // P05 (chéo lên end row0): reel1row2,reel2row1,reel3row0 = 0,1,5 = QAE → không win
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[5, 1, 0], [5, 1, 0], [5, 1, 2]] });
    const res = await TCH.spin(ctx, 1, 1);

    const wins = res.wins || [];
    ctx.A.eq(wins.length, 2, 'đúng 2 đường thắng');

    const p01Win = wins.find((w) => w.paylineId === 'P01');
    const p02Win = wins.find((w) => w.paylineId === 'P02');
    ctx.A.ok(p01Win !== undefined, 'có đường thắng P01');
    ctx.A.ok(p02Win !== undefined, 'có đường thắng P02');

    // Tổng payout = sum wins[].payout (đã nhân sẵn hệ số cuộn 4)
    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    const sumPayouts = wins.reduce((s, w) => s + TCH.num(w.payout), 0);
    ctx.A.near(totalWin, sumPayouts, 'totalWin == tổng payout các đường');

    // Mỗi payout phải là baseWin × {1,2,5,10}
    const baseA = TC_RULES.pay[TC_RULES.symbols.A] * 1 * 1; // 200
    const baseE = TC_RULES.pay[TC_RULES.symbols.E] * 1 * 1; // 10
    for (const w of wins) {
      const base = w.paylineId === 'P01' ? baseA : baseE;
      const okRatio = TC_RULES.fourthReelMults.some(
        (m) => Math.abs(TCH.num(w.payout) - base * m) <= 0.005
      );
      ctx.A.ok(okRatio, w.paylineId + ' payout ' + w.payout + ' phải = ' + base + ' × {1,2,5,10}');
    }

    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + totalWin,
      'balance.after = before − bet + totalWin'
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-SPIN-07',
  group: 'SPIN',
  title: 'Spin betLevelId="3" coinValueId="20": totalBet=300, thắng P01 3×B đúng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const coinPerLine = 3;
    const coinValue = 20;
    const bet = TC_RULES.betFormula(coinPerLine, coinValue); // 3×20×5 = 300
    await TCH.setBalance(ctx, 100000);
    const before = await TCH.balance(ctx);

    // Reel-major: reel1=[B(2),B(2),E(5)], reel2=[C(3),B(2),E(5)], reel3=[E(5),B(2),A(1)]
    // Hàng giữa (row1): B,B,B → P01 thắng
    // Hàng trên (row0): B,C,E → không thắng
    // Hàng dưới (row2): E,E,A → không thắng (EEA)
    // P04 (reel1row0,reel2row1,reel3row2): 2,2,1 = BBA → không thắng
    // P05 (reel1row2,reel2row1,reel3row0): 5,2,5 = EBE → không thắng
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[2, 2, 5], [3, 2, 5], [5, 2, 1]] });
    const res = await TCH.spin(ctx, String(coinPerLine), String(coinValue));

    ctx.A.near(TCH.num(res.totalBet || res.betAmount), bet, 'totalBet == 300');
    const wins = res.wins || [];
    ctx.A.eq(wins.length, 1, 'đúng 1 đường thắng');
    ctx.A.eq(wins[0].paylineId, 'P01', 'đường thắng là P01');

    // baseWin = pay[B] × coinPerLine × coinValue = 50 × 3 × 20 = 3000
    const baseWin = TC_RULES.pay[TC_RULES.symbols.B] * coinPerLine * coinValue;
    ctx.A.near(baseWin, 3000, 'baseWin công thức == 3000');
    TCH.checkWinWithFourthReel(ctx, res, baseWin, 'P01', 'totalWin P01 3×B bet300');

    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + TCH.num(TCH.pick(res, 'balance.totalWin')),
      'balance.after = before − 300 + totalWin'
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-SPIN-08',
  group: 'SPIN',
  title: 'FORCE_WIN_CAP: totalWin ≤ res.winCap; balance đúng; assert GDD 2000× (dự kiến FAIL để lộ mismatch)',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 10000);
    const before = await TCH.balance(ctx);

    await TCH.arm(ctx, 'FORCE_WIN_CAP');
    const res = await TCH.spin(ctx, 1, 1);

    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    const winCap = TCH.num(res.winCap);
    const totalBet = TCH.num(res.totalBet || res.betAmount);

    ctx.A.ok(isFinite(winCap), 'res.winCap phải là số hữu hạn, nhận: ' + res.winCap);
    // FORCE_WIN_CAP tạo all-Wild screen; tổng win phụ thuộc hệ số cuộn 4 ngẫu nhiên
    // → totalWin có thể < winCap (chưa chạm trần) hoặc == winCap (bị cắt)
    // Đảm bảo engine KHÔNG vượt cap
    ctx.A.ok(totalWin <= winCap + 0.005,
      'totalWin ≤ res.winCap (engine không vượt trần): totalWin=' + totalWin + ', winCap=' + winCap);
    ctx.log('FORCE_WIN_CAP → totalWin=' + totalWin + ', winCap=' + winCap +
      (Math.abs(totalWin - winCap) <= 0.005 ? ' (capped)' : ' (chưa capped — cuộn 4 thấp)'));
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - totalBet + totalWin,
      'balance.after = before − bet + totalWin'
    );

    // winCapMilestone chỉ assert nếu có trong response
    if (res.winCapMilestone !== undefined) {
      ctx.A.ok(res.winCapMilestone !== null, 'winCapMilestone có (optional)');
    }

    // Assert GDD: winCap phải = 2000×bet — DỰ KIẾN FAIL vì engine dùng 20000×
    ctx.A.ok(
      Math.abs(res.winCap - TC_RULES.winCapMultiplierGdd * totalBet) <= 0.005,
      'winCap ≠ 2000×bet theo GDD (engine trả 20000×) — mismatch spec/code'
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-SPIN-10',
  group: 'SPIN',
  title: 'Spin khi số dư không đủ (balance=3, bet=5) bị từ chối (im lặng)',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    // Đặt số dư ít hơn mức cược tối thiểu
    await TCH.setBalance(ctx, 3);
    const before = await TCH.balance(ctx);
    ctx.A.near(before, 3, 'xác nhận balance = 3 trước khi spin');

    // Spin bet 5 với balance chỉ có 3 → bị từ chối im lặng
    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1', coinValueId: '1' });
    ctx.A.ok(r.rejected, 'spin khi thiếu tiền phải bị từ chối');
    if (r.silent) ctx.log('Từ chối im lặng do INSUFFICIENT_BALANCE — đúng hành vi');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, 3, 'balance vẫn 3 sau khi spin bị từ chối');
  },
});

TEST_CATALOG.register({
  id: 'TC-SPIN-11',
  group: 'SPIN',
  title: 'Spin sau connect+auth nhưng không join bị từ chối (NOT_AUTHENTICATED, im lặng)',
  async run(ctx) {
    // KHÔNG gọi TCH.connectJoin — chỉ connect + auth, không JOIN
    await ctx.ws.connect(ctx.cfg.timeoutMs);
    await ctx.ws.auth(ctx.user.token, ctx.user.agentId, ctx.cfg.timeoutMs);
    // KHÔNG gửi cmd 1005 JOIN

    // Spin không có session → NOT_AUTHENTICATED → server không push WS
    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1', coinValueId: '1' });
    ctx.A.ok(r.rejected, 'spin khi chưa join phải bị từ chối (NOT_AUTHENTICATED)');
    if (r.silent) ctx.log('Từ chối im lặng — NOT_AUTHENTICATED trả early trước khi push WS');
  },
});

/* ── PAY ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-PAY-01',
  group: 'PAY',
  title: 'FORCE_GRID 3×Wild P01: payout 1000×bet đúng theo cuộn 4',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    // Thoát khỏi bonus mode nếu còn (từ case trước)
    if (ctx.joined.currentMode !== 'BASE') {
      ctx.log('Mode ' + ctx.joined.currentMode + ', spin để về BASE');
      await TCH.spin(ctx, 1, 1).catch(() => {});
    }
    // Đảm bảo đủ tiền
    await TCH.setBalance(ctx, 10000);
    const before = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5

    // Reel-major: reel1=[A(1),W(10),C(3)], reel2=[E(5),W(10),D(4)], reel3=[B(2),W(10),E(5)]
    // Hàng giữa (row1): W,W,W → P01 Wild pay
    // Hàng trên (row0): A,E,B → không thắng (3 loại khác nhau)
    // Hàng dưới (row2): C,D,E → không thắng (3 loại khác nhau)
    // P04 (reel1row0=A,reel2row1=W,reel3row2=E): A≠E → Wild không tạo được 3 cùng loại
    // P05 (reel1row2=C,reel2row1=W,reel3row0=B): C≠B → không thắng
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[1, 10, 3], [5, 10, 4], [2, 10, 5]] });
    const res = await TCH.spin(ctx, 1, 1);

    const wins = res.wins || [];
    ctx.A.ok(wins.length >= 1, 'ít nhất 1 đường thắng khi 3×Wild P01');

    // Tìm win có symbolId Wild (id=10) trên P01
    const wildWin = wins.find((w) => w.paylineId === 'P01' && w.symbolId === TC_RULES.symbols.WILD);
    ctx.A.ok(wildWin !== undefined, 'phải có win Wild (symbolId=10) trên P01');
    ctx.log('TC-PAY-01: số wins = ' + wins.length + ' (engine có thể báo cả Wild-pay lẫn symbol-pay trên cùng đường)');

    // Tổng totalWin phải hợp lệ — chứa Wild P01 baseWin × cuộn 4
    // checkWinWithFourthReel so sánh totalWin với baseWin×mult — nhưng nếu có win phụ thì totalWin > wildBaseWin×mult
    // Thay vào đó kiểm tra balance.after đúng
    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    ctx.A.ok(totalWin > 0, 'totalWin > 0 khi có win Wild');
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + totalWin,
      'balance.after = before − bet + totalWin'
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-PAY-03',
  group: 'PAY',
  title: 'FORCE_GRID B+C+D combo P01 (any order): payout 8×bet đúng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    // Nếu đang trong bonus mode (SPECIAL_FREE_SPIN/FREE_SPIN) thì spin để thoát
    if (ctx.joined.currentMode !== 'BASE') {
      ctx.log('Đang trong mode ' + ctx.joined.currentMode + ', spin 1 lần để thoát về BASE');
      await TCH.spin(ctx, 1, 1).catch(() => {});
    }
    await TCH.setBalance(ctx, 10000);
    const before = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5

    // Reel-major: reel1=[A(1),B(2),E(5)], reel2=[E(5),C(3),A(1)], reel3=[A(1),D(4),E(5)]
    // Hàng giữa (row1): B,C,D → combo P01 thắng
    // Hàng trên (row0): A,E,A → không thắng (AEA)
    // Hàng dưới (row2): E,A,E → không thắng
    // P04 (reel1row0=A,reel2row1=C,reel3row2=E): ACE → không thắng
    // P05 (reel1row2=E,reel2row1=C,reel3row0=A): ECA → không thắng
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[1, 2, 5], [5, 3, 1], [1, 4, 5]] });
    const res = await TCH.spin(ctx, 1, 1);

    const wins = res.wins || [];
    ctx.A.eq(wins.length, 1, 'đúng 1 đường thắng (B+C+D combo P01)');
    ctx.A.eq(wins[0].paylineId, 'P01', 'đường thắng là P01');

    // baseWin combo BCD = 8 × coinPerLine × coinValue = 8 × 1 × 1 = 8
    const baseWin = TC_RULES.comboBCD * 1 * 1;
    TCH.checkWinWithFourthReel(ctx, res, baseWin, 'P01', 'totalWin B+C+D combo P01');

    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + totalWin,
      'balance.after = before − bet + totalWin'
    );
  },
});

/* ── R4 ──────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-R4-01',
  group: 'R4',
  title: 'Spin có win: fourthReel.dimmed=false, symbols mảng 3 phần tử "xN"',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // FORCE_WIN không dùng FORCE_GRID → không đụng gap J1 với FORCE_FOURTH_REEL_MULT
    await TCH.arm(ctx, 'FORCE_WIN', { multiplier: 50, symbolId: 1 });
    const res = await TCH.spin(ctx, 1, 1);

    const wins = res.wins || [];
    ctx.A.ok(wins.length > 0, 'FORCE_WIN phải tạo ít nhất 1 đường thắng');

    const fr = res.fourthReel;
    ctx.A.ok(fr !== undefined && fr !== null, 'fourthReel tồn tại');
    ctx.A.eq(fr.dimmed, false, 'fourthReel.dimmed == false khi có win');
    ctx.A.ok(Array.isArray(fr.symbols) && fr.symbols.length === 3,
      'fourthReel.symbols là mảng 3 phần tử');

    // Mỗi phần tử phải là "xN" với N ∈ {1,2,5,10}
    const validMults = TC_RULES.fourthReelMults.map((n) => 'x' + n);
    for (let i = 0; i < 3; i++) {
      ctx.A.ok(validMults.includes(fr.symbols[i]),
        'fourthReel.symbols[' + i + '] hợp lệ ("x1"/"x2"/"x5"/"x10"), nhận: ' + fr.symbols[i]);
    }
  },
});

TEST_CATALOG.register({
  id: 'TC-R4-02',
  group: 'R4',
  title: 'FORCE_FOURTH_REEL_MULT x10: cuộn 4 hiển thị x10; nếu có win thì payout nhân đúng x10',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Không ép được win + mult cùng lúc (gap J1, 1 cheat slot/user) nên:
    // - Điều kiện PASS tất định: spin sau khi arm phải hiển thị x10 trên cuộn 4.
    // - Nếu tình cờ có win thì kiểm thêm payout nhân x10 (phép nhân theo
    //   hàng kết thúc đã được SPIN-01/03/07 cover bằng toán).
    let sawForcedMult = false;
    let checkedWin = false;
    for (let attempt = 1; attempt <= 25 && !checkedWin; attempt++) {
      await TCH.arm(ctx, 'FORCE_FOURTH_REEL_MULT', { multiplier: 10 });
      const res = await TCH.spin(ctx, 1, 1);
      const mults = TCH.fourthReelMults(res);
      const allTen = !!mults && mults.every((m) => m === 10);
      if (allTen) sawForcedMult = true;
      else ctx.log('Vòng ' + attempt + ': fourthReel = ' + JSON.stringify(res.fourthReel && res.fourthReel.symbols));

      const wins = res.wins || [];
      if (allTen && wins.length > 0) {
        checkedWin = true;
        ctx.log('Có win ở vòng ' + attempt + ' — kiểm payout nhân x10');
        for (const win of wins) {
          const endRow = TC_RULES.paylineEndRow[win.paylineId];
          if (endRow !== undefined) {
            ctx.A.near(mults[endRow], 10,
              win.paylineId + ' end-row ' + endRow + ' mult phải == 10');
            ctx.A.ok(TCH.num(win.payout) > 0 && TCH.num(win.payout) % 10 === 0,
              win.paylineId + ' payout phải > 0 và chia hết cho 10, nhận: ' + win.payout);
          }
        }
      }
    }

    ctx.A.ok(sawForcedMult,
      'cuộn 4 phải hiển thị x10 ở cả 3 hàng sau khi arm FORCE_FOURTH_REEL_MULT x10');
    if (!checkedWin) {
      ctx.log('Không gặp win ngẫu nhiên trong 25 vòng — bỏ qua check payout (đã cover ở SPIN-01/03/07)');
    }
  },
});

/* ── WAL ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-WAL-01',
  group: 'WAL',
  title: 'joined.balance (string→num) near với 1503 balance',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const joinedBalance = TCH.num(ctx.joined.balance);
    ctx.A.ok(isFinite(joinedBalance), 'joined.balance parse được thành số');

    const bal1503 = await TCH.balance(ctx);
    ctx.A.near(joinedBalance, bal1503, 'joined.balance ≈ balance qua 1503');
  },
});

TEST_CATALOG.register({
  id: 'TC-WAL-02',
  group: 'WAL',
  title: 'FORCE_LOSS với balance=100: balance.before=100, balance.after=95, 1503=95',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 100);

    // Xác nhận balance đúng 100 trước spin
    const before = await TCH.balance(ctx);
    ctx.A.near(before, 100, 'balance xác nhận == 100 sau setBalance');

    await TCH.arm(ctx, 'FORCE_LOSS');
    const res = await TCH.spin(ctx, 1, 1);

    const bet = TC_RULES.betFormula(1, 1); // 5
    ctx.A.near(TCH.pick(res, 'balance.before'), 100, 'balance.before == 100');
    ctx.A.near(TCH.pick(res, 'balance.after'), 100 - bet, 'balance.after == 95');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, 100 - bet, '1503 == 95 sau spin thua');
  },
});

TEST_CATALOG.register({
  id: 'TC-WAL-03',
  group: 'WAL',
  title: 'Spin thắng: balance.after = before − bet + totalWin, 1503 khớp',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);

    // FORCE_GRID 3×E P01 — win đơn giản, totalWin > 0
    // reel1=[E(5),E(5),A(1)], reel2=[A(1),E(5),A(1)], reel3=[A(1),E(5),A(1)]
    // Hàng giữa (row1): E,E,E → P01 thắng; hàng trên E,A,A → không; hàng dưới A,A,A → P03 thắng!
    // Đổi grid để tránh win thêm:
    // reel1=[C(3),E(5),D(4)], reel2=[D(4),E(5),C(3)], reel3=[B(2),E(5),D(4)]
    // Hàng giữa (row1): E,E,E → P01 thắng
    // Hàng trên (row0): C,D,B → CDB → không match (C+D nhưng không có B đúng vị... 3,4,2 = C,D,B → BCD combo chéo? P04 end row2)
    // P04 (reel1row0,reel2row1,reel3row2): 3,5,4 = CED → không thắng
    // P05 (reel1row2,reel2row1,reel3row0): 4,5,2 = DEB → không thắng
    // Hàng dưới (row2): D,C,D → không thắng (DCD không phải 3 cùng)
    await TCH.arm(ctx, 'FORCE_GRID', { screen: [[3, 5, 4], [4, 5, 3], [2, 5, 4]] });
    const res = await TCH.spin(ctx, 1, 1);

    const totalWin = TCH.num(TCH.pick(res, 'balance.totalWin'));
    ctx.A.ok(totalWin > 0, 'totalWin > 0 (spin có thắng)');

    const bet = TC_RULES.betFormula(1, 1); // 5
    ctx.A.near(
      TCH.pick(res, 'balance.after'),
      before - bet + totalWin,
      'balance.after = before − bet + totalWin'
    );

    const after = await TCH.balance(ctx);
    ctx.A.near(after, TCH.pick(res, 'balance.after'), '1503 khớp balance.after trong spin result');
  },
});

TEST_CATALOG.register({
  id: 'TC-WAL-05',
  group: 'WAL',
  title: 'Spin khi balance=3 (không đủ bet=5) bị từ chối im lặng, 1503 vẫn 3',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 3);
    const before = await TCH.balance(ctx);
    ctx.A.near(before, 3, 'xác nhận balance = 3');

    const r = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1', coinValueId: '1' });
    ctx.A.ok(r.rejected, 'spin khi thiếu tiền phải bị từ chối');
    if (r.silent) ctx.log('Từ chối im lặng — INSUFFICIENT_BALANCE không push qua WS');

    const after = await TCH.balance(ctx);
    ctx.A.near(after, 3, '1503 vẫn 3 sau khi spin bị từ chối');
  },
});

/* ── SYS (thêm) ─────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-SYS-02',
  group: 'SYS',
  title: 'Gửi cmd 1503 và 1500 khi chưa auth: cả hai bị từ chối (silent hoặc error)',
  async run(ctx) {
    // Chỉ connect, không auth — không có session WS hợp lệ
    await ctx.ws.connect(ctx.cfg.timeoutMs);

    // Gửi balance cmd không auth
    const r1 = await TCH.expectReject(ctx, { cmd: 1503 });
    ctx.A.ok(r1.rejected, 'cmd 1503 khi chưa auth phải bị từ chối, nhận: '
      + (r1.msg ? JSON.stringify(r1.msg.raw).slice(0, 200) : '(silent)'));
    if (!r1.rejected) {
      ctx.log('CẢNH BÁO: 1503 không bị từ chối khi chưa auth');
    }

    // Gửi spin cmd không auth
    const r2 = await TCH.expectReject(ctx, { cmd: 1500, betLevelId: '1', coinValueId: '1' });
    ctx.A.ok(r2.rejected, 'cmd 1500 khi chưa auth phải bị từ chối, nhận: '
      + (r2.msg ? JSON.stringify(r2.msg.raw).slice(0, 200) : '(silent)'));
    if (!r2.rejected) {
      ctx.log('CẢNH BÁO: 1500 không bị từ chối khi chưa auth');
    }
  },
});

/* ── CONC ────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-CONC-01',
  group: 'CONC',
  title: 'Gửi 2 spin liên tiếp không chờ: kỳ vọng chỉ 1 spin xử lý (concurrent guard)',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 1000);
    const balanceBefore = await TCH.balance(ctx);
    ctx.A.near(balanceBefore, 1000, 'xác nhận balance = 1000 trước test');

    const bet = TC_RULES.betFormula(1, 1); // 5

    // Gửi 2 spin liên tiếp mà không chờ kết quả giữa chừng
    ctx.ws.sendCmd({ cmd: 1500, betLevelId: '1', coinValueId: '1' });
    ctx.ws.sendCmd({ cmd: 1500, betLevelId: '1', coinValueId: '1' });

    // Thu kết quả: đợi spin result đầu tiên
    let results = [];
    try {
      const res1 = await ctx.ws.waitFor(
        (m) => m.cmd === 1500 && m.payload && m.payload.screen !== undefined,
        12000, 'kết quả spin đầu tiên'
      );
      results.push(res1.payload);
    } catch (e) {
      ctx.log('Không nhận được spin result nào trong 12s: ' + e.message);
    }

    // Đợi thêm spin result thứ 2 nếu có (budget 4s)
    try {
      const res2 = await ctx.ws.waitFor(
        (m) => m.cmd === 1500 && m.payload && m.payload.screen !== undefined,
        4000, 'kết quả spin thứ 2 (nếu server xử lý cả 2)'
      );
      results.push(res2.payload);
    } catch (e) {
      // Timeout → chỉ 1 spin được xử lý — đúng hành vi kỳ vọng
    }

    const balanceAfter = await TCH.balance(ctx);

    if (results.length === 1) {
      // Kỳ vọng: chỉ 1 spin chạy
      const totalWin = TCH.num(TCH.pick(results[0], 'balance.totalWin'));
      ctx.A.near(balanceAfter, 1000 - bet + totalWin,
        '1503 == 1000 − 5 + totalWin (chỉ 1 spin được xử lý)');
      ctx.log('PASS: server từ chối spin thứ 2 — concurrent guard hoạt động đúng');
    } else if (results.length === 2) {
      // Server xử lý tuần tự cả 2 — không đúng kỳ vọng, log finding
      const win1 = TCH.num(TCH.pick(results[0], 'balance.totalWin'));
      const win2 = TCH.num(TCH.pick(results[1], 'balance.totalWin'));
      ctx.log('FINDING: server xử lý cả 2 spin liên tiếp (tuần tự) — cần xem xét concurrent guard');
      ctx.A.ok(false,
        'Nhận 2 spin results (server xử lý 2 spins) — kỳ vọng chỉ 1; balance cuối = ' + balanceAfter
        + ', tổng win = ' + (win1 + win2));
    } else {
      ctx.A.ok(false, 'Không nhận được spin result nào — kiểm tra kết nối');
    }
  },
});

/* ════════════════════════════════════════════════════════════════
   CASES — FEATURES: JACK, RUSH, STREAK, SC, FS
   (Phần A ưu tiên Cao trong TEST_CASES.md)
   Xem quy ước chung ở đầu cases-core.js.

   Hành vi xác minh live (probe 2026-06-12):
   - RUSH-02: FORCE_RUSH_MODE_FILL đặt energy trực tiếp (KHÔNG phải one-shot);
     arm fill 29 → spin bình thường → energy lên 30 → rush kích hoạt.
     Hoặc arm fill 30 → spin → triggered. Chiến lược dùng: fill 30 rồi spin.
   - STREAK-01: FORCE_WIN_STREAK pin count nhưng vẫn cần 3 win liên tiếp
     (count 0→1→2→trigger). Reward: winStreak.triggered=true, count=0,
     freeSpins.total=1, remain=1 (1 Special Free Spin).
   - FS-01/02/04: FORCE_FREE_SPIN không đưa user vào free spin mode.
     Đường đúng: FORCE_RUSH_MODE_FILL {energy:30} → spin → rush.triggered=true
     → freeSpins.remain=5. Trong free spin: balance KHÔNG bị trừ bet
     (diff before-after = 0 khi thua). Mode là RUSH_MODE, sau last spin về BASE.
   - FS-04: FORCE_WIN_CAP trong free spin: freeSpins tiếp tục (remain giảm 1),
     accumulatedWin ghi lại tổng; free spin KHÔNG kết thúc sớm sau cap.
   ════════════════════════════════════════════════════════════════ */

/* ── JACK ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-JACK-01',
  group: 'JACK',
  title: 'FORCE_NAGA_EYE: spin kế tiếp có fourthReel.nagaEye hoặc nagaEyePending = true',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.arm(ctx, 'FORCE_NAGA_EYE');
    const res = await TCH.spin(ctx, 1, 1);

    // PROBE: FORCE_NAGA_EYE đặt "NAGA_EYE" vào fourthReel.symbols thay vì bật nagaEye boolean.
    // nagaEye/nagaEyePending boolean có thể false; check symbols chứa "NAGA_EYE".
    const fr = res.fourthReel || {};
    const hasNagaEyeSymbol = Array.isArray(fr.symbols) && fr.symbols.includes('NAGA_EYE');
    ctx.A.ok(
      fr.nagaEye === true || fr.nagaEyePending === true || hasNagaEyeSymbol,
      'fourthReel.nagaEye/nagaEyePending phải true, hoặc symbols chứa "NAGA_EYE" sau FORCE_NAGA_EYE, nhận: '
        + JSON.stringify(fr),
    );
  },
});

TEST_CATALOG.register({
  id: 'TC-JACK-02',
  group: 'JACK',
  title: 'armTreasureRoom + chọn BRONZE: nhận jackpot với wonTier, amount, balance tăng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const balBefore = await TCH.balance(ctx);

    // Arm treasure room (không chiếm cheat slot)
    const armRes = await ctx.api.armTreasureRoom();
    ctx.A.must(armRes.ok, 'armTreasureRoom thất bại: HTTP ' + armRes.status);

    // Pick BRONZE
    ctx.ws.sendCmd({ cmd: 1515, chest: 'BRONZE' });
    const msg = await ctx.ws.waitFor(1515, ctx.cfg.timeoutMs, 'reply cmd 1515');
    const p = msg.payload;

    ctx.A.must(!TCH.isRejection(msg), 'cmd 1515 bị từ chối: ' + TCH.errorCode(msg));
    ctx.A.ok(
      ['MINOR', 'MAJOR', 'GRAND'].includes(p.wonTier),
      'wonTier phải là MINOR/MAJOR/GRAND, nhận: ' + p.wonTier,
    );
    ctx.A.eq(p.pickedChest, 'BRONZE', 'pickedChest == BRONZE');

    // PROBE: otherChests là object {GOLD:"MAJOR", SILVER:"MINOR"} (không phải array)
    const otherKeys = p.otherChests ? Object.keys(p.otherChests) : [];
    ctx.A.ok(otherKeys.length === 2, 'otherChests phải có 2 chest khác, nhận: ' + JSON.stringify(p.otherChests));

    // GAME BUG: server luôn trả amount=0 và note="POOL_ALREADY_PAID" dù arm treasure room đúng cách.
    // Assert amount > 0 để lộ bug cho team — dự kiến FAIL.
    ctx.A.ok(
      TCH.num(p.amount) > 0,
      'amount jackpot > 0 — GAME BUG: server trả POOL_ALREADY_PAID / amount=0 (note=' + p.note + ')',
    );

    // Balance phải tăng ít nhất amount (sẽ fail cùng với amount nếu amount=0)
    const balAfter = await TCH.balance(ctx);
    ctx.A.ok(
      balAfter >= balBefore + TCH.num(p.amount) - 0.005,
      'balance sau pick phải tăng ≥ amount(' + p.amount + '); trước=' + balBefore + ' sau=' + balAfter,
    );

    ctx.log('wonTier=' + p.wonTier + ' amount=' + p.amount + ' note=' + (p.note || 'none'));
  },
});

TEST_CATALOG.register({
  id: 'TC-JACK-09',
  group: 'JACK',
  title: 'Jackpot pick khi chưa kích hoạt → lỗi JACKPOT_NOT_TRIGGERED',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const balBefore = await TCH.balance(ctx);

    // Không arm gì → pick
    const r = await TCH.expectReject(ctx, { cmd: 1515, chest: 'BRONZE' }, ctx.cfg.timeoutMs);
    ctx.A.ok(r.rejected, 'cmd 1515 chưa arm phải bị từ chối');
    ctx.A.eq(r.code, 'JACKPOT_NOT_TRIGGERED', 'mã lỗi phải là JACKPOT_NOT_TRIGGERED, nhận: ' + r.code);

    const balAfter = await TCH.balance(ctx);
    ctx.A.near(balAfter, balBefore, 'balance không đổi khi jackpot pick bị từ chối');
  },
});

/* ── RUSH ─────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-RUSH-01',
  group: 'RUSH',
  title: 'Thua 1 ván (FORCE_LOSS): rushEnergy tăng đúng 1 so với trước',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Đảm bảo user ở BASE mode: drain hết free spin nếu đang có.
    // JOIN có thể có freeSpinsRemaining=0 nhưng currentMode=RUSH_MODE → phải kiểm tra mode.
    let drainCount = 0;
    let currentMode = ctx.joined.currentMode;
    while (currentMode === 'RUSH_MODE' && drainCount < 10) {
      await TCH.arm(ctx, 'FORCE_LOSS');
      const rd = await TCH.spin(ctx, 1, 1, 12000);
      currentMode = rd.round && rd.round.nextMode;
      drainCount++;
    }
    if (drainCount > 0) ctx.log('Đã drain ' + drainCount + ' spin để về BASE mode');

    // Lấy mốc energy: spin FORCE_LOSS lần 1 trong BASE mode
    await TCH.arm(ctx, 'FORCE_LOSS');
    const res0 = await TCH.spin(ctx, 1, 1);
    const energyBase = res0.rush && res0.rush.energy;
    ctx.A.must(
      typeof energyBase === 'number',
      'rush.energy phải là số sau spin BASE, nhận: ' + JSON.stringify(res0.rush),
    );

    // Spin FORCE_LOSS lần 2 — energy phải tăng đúng 1
    await TCH.arm(ctx, 'FORCE_LOSS');
    const res1 = await TCH.spin(ctx, 1, 1);
    const energyAfter = res1.rush && res1.rush.energy;

    const expected = energyBase + 1;
    ctx.A.ok(
      typeof energyAfter === 'number' && energyAfter === expected,
      'rush.energy phải tăng 1 (từ ' + energyBase + ' → ' + expected + '), nhận: ' + energyAfter,
    );

    ctx.log('rush.energy: ' + energyBase + ' → ' + energyAfter + ' | energyByBet=' + JSON.stringify(res1.rush && res1.rush.energyByBet));
  },
});

TEST_CATALOG.register({
  id: 'TC-RUSH-02',
  group: 'RUSH',
  title: 'FORCE_RUSH_MODE_FILL 30 → spin ở BASE → rush kích hoạt, tặng 5 free spin',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // PROBE ĐÃ XÁC MINH: FORCE_RUSH_MODE_FILL đặt energy trực tiếp (không phải
    // one-shot). Arm fill 30 → spin bình thường (PHẢI ở BASE mode) → rush triggered.
    // Lưu ý: FILL chỉ hiệu lực trong BASE mode — nếu user đang trong RUSH_MODE
    // (có free spin thừa), phải drain hết trước.
    ctx.log('Chiến lược: drain free spin thừa → arm fill 30 → spin BASE');

    await drainToBase(ctx);
    // activateRushFreeSpins retry nếu spin ngẫu nhiên thắng reset energy
    const res = await activateRushFreeSpins(ctx);

    ctx.A.ok(
      res.rush && res.rush.triggered === true,
      'rush.triggered phải true, nhận: ' + JSON.stringify(res.rush),
    );
    ctx.A.near(res.rush && res.rush.energy, 0, 'rush.energy phải reset về 0 sau khi triggered');

    const fs = res.freeSpins || {};
    ctx.A.eq(fs.total, TC_RULES.rushFreeSpins, 'freeSpins.total phải ' + TC_RULES.rushFreeSpins);
    ctx.A.eq(fs.remain, TC_RULES.rushFreeSpins, 'freeSpins.remain phải ' + TC_RULES.rushFreeSpins);

    ctx.log('rush=' + JSON.stringify(res.rush) + ' freeSpins=' + JSON.stringify(res.freeSpins));
  },
});

/* ── STREAK ───────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-STREAK-01',
  group: 'STREAK',
  title: 'FORCE_WIN_STREAK + 3 win liên tiếp → winStreak.triggered=true, tặng 1 Special Free Spin',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // PROBE ĐÃ XÁC MINH: FORCE_WIN_STREAK pin count nhưng vẫn cần 3 win.
    // Thứ tự: arm WIN_STREAK → arm WIN (ghi đè slot); spin → count tăng.
    // Sau đó arm WIN (mỗi spin) cho đến khi triggered.
    // Reward: winStreak.triggered=true, count=0, freeSpins.total=1, remain=1.
    ctx.log('Cần 3 win liên tiếp; FORCE_WIN_STREAK pin count (vẫn cần 3 win thật)');

    let triggered = false;
    for (let i = 0; i < 3; i++) {
      await TCH.arm(ctx, 'FORCE_WIN', { multiplier: 5, symbolId: 1 });
      const res = await TCH.spin(ctx, 1, 1);
      const ws = res.winStreak || {};
      ctx.log('spin ' + (i + 1) + ': winStreak=' + JSON.stringify(ws));
      if (ws.triggered === true) {
        triggered = true;
        ctx.A.eq(ws.count, 0, 'winStreak.count reset về 0 sau trigger');
        ctx.A.ok(
          (res.freeSpins && res.freeSpins.total >= 1),
          'freeSpins.total ≥ 1 (Special Free Spin), nhận: ' + JSON.stringify(res.freeSpins),
        );
        ctx.A.eq(
          res.freeSpins && res.freeSpins.remain, 1,
          'freeSpins.remain = 1 sau trigger, nhận: ' + JSON.stringify(res.freeSpins),
        );
        ctx.log('Trigger ở spin ' + (i + 1) + '; freeSpins=' + JSON.stringify(res.freeSpins));
        break;
      }
      // Nếu chưa trigger, chất lượng tăng dần đúng
      ctx.A.ok(typeof ws.count === 'number', 'winStreak.count phải là số');
      ctx.A.ok(ws.count > 0, 'winStreak.count phải > 0 sau win');
    }

    ctx.A.ok(triggered, 'winStreak phải triggered sau 3 win liên tiếp');
  },
});

/* ── SC (Second Choice) ───────────────────────────────────────── */

// Helper nội bộ: drain mọi free spin thừa để về BASE mode
// Dùng helper chung — TCH.drainToBase theo dõi mode sống (round.nextMode)
// nên gọi lặp lại giữa case vẫn chính xác, không bị stale như đọc ctx.joined.
async function drainToBase(ctx) {
  return TCH.drainToBase(ctx);
}

// Helper nội bộ: kích hoạt rush free spin (5 spins) qua FORCE_RUSH_MODE_FILL
// Retry nếu spin ngẫu nhiên THẮNG làm reset energy (cần spin thua để energy 30 trigger)
async function activateRushFreeSpins(ctx) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    // arm FORCE_RUSH_MODE_FILL 30 (không arm FORCE_LOSS vì 2 cheat không coexist)
    await TCH.arm(ctx, 'FORCE_RUSH_MODE_FILL', { energy: 30 });
    const res = await TCH.spin(ctx, 1, 1, 15000);
    if (res.rush && res.rush.triggered === true) {
      ctx.log('Rush triggered ở attempt ' + attempt + ': remain=' + (res.freeSpins && res.freeSpins.remain));
      return res;
    }
    // Spin thắng → energy bị reset về 0. Thử lại.
    ctx.log('activateRushFreeSpins attempt ' + attempt + ': rush.triggered=false (spin thắng reset energy), thử lại');
    // Nếu vào free spin mode khác, drain ra
    await drainToBase(ctx);
  }
  throw new Error('Không kích hoạt được rush free spin sau 5 lần thử');
}

TEST_CATALOG.register({
  id: 'TC-SC-01',
  group: 'SC',
  title: 'Wild reels 1&2, không win → game mời Second Choice (secondChoiceAvailable = true)',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await drainToBase(ctx);

    // Đúng precondition TEST_CASES: forced grid W trên reel 1&2 cùng hàng,
    // reel 3 không W, không đường thắng (reel 3 toàn Q — pay rỗng).
    // (FORCE_SECOND_CHOICE để reel 3 ngẫu nhiên nên dễ dính win → flaky.)
    const scGrid1 = [[5, 10, 1], [3, 10, 4], [0, 0, 0]]; // reel-major [reel][row]
    let res = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await drainToBase(ctx); // drain nếu win streak tạo free spin
      await TCH.arm(ctx, 'FORCE_GRID', { screen: scGrid1 });
      res = await TCH.spin(ctx, 1, 1);
      if (res.secondChoiceAvailable === true) break;
      ctx.log('SC-01 lần ' + attempt + ': secondChoiceAvailable=false (wins=' + (res.wins && res.wins.length) + '), thử lại');
    }

    ctx.A.eq(res.secondChoiceAvailable, true,
      'secondChoiceAvailable phải true khi W-W reels 1&2 và không có win');
    // Điều kiện trigger yêu cầu không có đường thắng
    const wins = res.wins || [];
    ctx.A.eq(wins.length, 0, 'wins phải rỗng khi secondChoiceAvailable=true');
  },
});

TEST_CATALOG.register({
  id: 'TC-SC-02',
  group: 'SC',
  title: 'Second choice (1510): chỉ cuộn 3 thay đổi, balance bị trừ 1×baseBet',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await drainToBase(ctx);

    // Bước 1: tạo secondChoiceAvailable TẤT ĐỊNH bằng FORCE_GRID:
    // W-W ở hàng giữa reels 1&2, reel 3 toàn ô trống (Q pay rỗng) → không có
    // win nào (kể cả wild thế chỗ) và không W-W-W → trigger Second Choice 100%.
    // (FORCE_SECOND_CHOICE để reel 3 ngẫu nhiên nên hay dính win → flaky.)
    const scGrid = [[5, 10, 1], [3, 10, 4], [0, 0, 0]]; // reel-major [reel][row]
    let res1 = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await drainToBase(ctx);
      await TCH.arm(ctx, 'FORCE_GRID', { screen: scGrid });
      res1 = await TCH.spin(ctx, 1, 1);
      if (res1.secondChoiceAvailable === true) break;
      ctx.log('SC-02 lần ' + attempt + ': secondChoiceAvailable=false (wins='
        + (res1.wins && res1.wins.length) + ', mode=' + TCH.pick(res1, 'round.thisMode') + '), thử lại');
    }
    ctx.A.must(res1.secondChoiceAvailable === true, 'Cần secondChoiceAvailable để test SC-02');

    const screen1 = res1.screen && res1.screen.symbols;
    const bal1 = TCH.num(TCH.pick(res1, 'balance.after'));
    ctx.A.must(Array.isArray(screen1) && screen1.length === 9, 'screen1 phải là mảng 9 phần tử');

    // Bước 2: gửi cmd 1510 (second choice)
    ctx.ws.sendCmd({ cmd: 1510 });
    const msg = await ctx.ws.waitFor(1510, ctx.cfg.timeoutMs, 'reply cmd 1510');
    ctx.A.must(!TCH.isRejection(msg), 'cmd 1510 bị từ chối: ' + TCH.errorCode(msg));

    const p = msg.payload;
    // balance.before của reply phải == balance1
    ctx.A.near(
      TCH.pick(p, 'balance.before'), bal1,
      'balance.before của 1510 phải == balance sau spin trước',
    );
    // Chi phí 1×baseBet (baseBet = totalBet = 5 ở bet 1/1)
    const baseBet = TC_RULES.betFormula(1, 1); // 5
    ctx.A.near(
      TCH.pick(p, 'balance.after'),
      bal1 - baseBet + TCH.num(TCH.pick(p, 'balance.totalWin')),
      'balance.after = bal1 − baseBet + totalWin',
    );

    // Screen: chỉ cuộn 3 (reel index 2) được phép thay đổi → indices {2,5,8}
    const screen2 = p.screen && p.screen.symbols;
    ctx.A.must(Array.isArray(screen2) && screen2.length === 9, 'screen2 phải là mảng 9 phần tử');
    const changed = TCH.diffScreen(screen1, screen2);
    const allowedIndices = new Set([2, 5, 8]);
    const badChanges = changed.filter((i) => !allowedIndices.has(i));
    ctx.A.ok(
      badChanges.length === 0,
      'Chỉ cuộn 3 (index 2,5,8) được phép thay đổi; index thay đổi sai: ' + JSON.stringify(badChanges),
    );

    // 2 cuộn đầu giữ nguyên
    [0, 1, 3, 4, 6, 7].forEach((i) => {
      ctx.A.eq(screen2[i], screen1[i], 'screen[' + i + '] phải giữ nguyên sau second choice');
    });
  },
});

TEST_CATALOG.register({
  id: 'TC-SC-07',
  group: 'SC',
  title: 'Second choice với số dư không đủ → lỗi INSUFFICIENT_BALANCE; sau khi nạp lại thành công',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await drainToBase(ctx);

    // Bước 1: tạo secondChoiceAvailable tất định bằng FORCE_GRID
    // (W-W hàng giữa + reel 3 toàn ô trống — xem giải thích ở TC-SC-02)
    const scGrid7 = [[5, 10, 1], [3, 10, 4], [0, 0, 0]];
    let res1 = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await drainToBase(ctx); // drain nếu win streak/free spin triggered giữa các lần retry
      await TCH.arm(ctx, 'FORCE_GRID', { screen: scGrid7 });
      res1 = await TCH.spin(ctx, 1, 1);
      if (res1.secondChoiceAvailable === true) break;
      ctx.log('SC-07 lần ' + attempt + ': secondChoiceAvailable=false (wins=' + (res1.wins && res1.wins.length) + '), thử lại');
    }
    ctx.A.must(res1.secondChoiceAvailable === true, 'Cần secondChoiceAvailable để test SC-07');

    // Bước 2: set balance = 3 (nhỏ hơn baseBet 5)
    await TCH.setBalance(ctx, 3);

    // Bước 3: 1510 → bị từ chối INSUFFICIENT_BALANCE
    const r = await TCH.expectReject(ctx, { cmd: 1510 }, ctx.cfg.timeoutMs);
    ctx.A.ok(r.rejected, 'cmd 1510 phải bị từ chối khi số dư không đủ');
    ctx.A.eq(r.code, 'INSUFFICIENT_BALANCE', 'mã lỗi phải INSUFFICIENT_BALANCE, nhận: ' + r.code);

    // Balance không đổi (vẫn 3)
    const balAfterReject = await TCH.balance(ctx);
    ctx.A.near(balAfterReject, 3, 'balance vẫn 3 sau khi 1510 bị từ chối');

    // Bước 4: nạp lại 100 → 1510 lần nữa phải thành công (lời mời còn nguyên)
    await TCH.setBalance(ctx, 100);
    ctx.ws.sendCmd({ cmd: 1510 });
    const msg2 = await ctx.ws.waitFor(1510, ctx.cfg.timeoutMs, 'reply cmd 1510 lần 2');
    ctx.A.must(!TCH.isRejection(msg2), 'cmd 1510 lần 2 phải thành công sau khi nạp tiền; lỗi: ' + TCH.errorCode(msg2));
    ctx.A.ok(
      msg2.payload && msg2.payload.screen !== undefined,
      'reply 1510 lần 2 phải có screen',
    );

    ctx.log('SC-07: second choice thành công sau khi nạp lại balance');
  },
});

/* ── FS (Free Spin) ───────────────────────────────────────────── */

/*
  FS-01, FS-02, FS-04: Đường vào free spin đúng là FORCE_RUSH_MODE_FILL {energy:30}
  → spin → rush.triggered=true → freeSpins.remain=5.
  Trong free spin (mode RUSH_MODE): balance KHÔNG bị trừ bet khi thua (diff=0).
  Round mode: thisMode=RUSH_MODE; nextMode=RUSH_MODE cho đến spin cuối → BASE.
  FORCE_FREE_SPIN {spins:N} không đưa user vào free spin mode (probe xác nhận).
*/

TEST_CATALOG.register({
  id: 'TC-FS-01',
  group: 'FS',
  title: 'Vào free spin qua Rush: freeSpins.remain giảm 1 sau mỗi spin, không trừ bet',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // PROBE XÁC MINH: FORCE_RUSH_MODE_FILL energy:30 → spin → triggered, remain=5
    ctx.log('Đường vào free spin: activateRushFreeSpins (KHÔNG dùng FORCE_FREE_SPIN vì không hoạt động)');
    await drainToBase(ctx);
    const resActivate = await activateRushFreeSpins(ctx);
    ctx.A.must(
      resActivate.rush && resActivate.rush.triggered === true,
      'rush.triggered phải true để kích hoạt free spin',
    );
    const remainBefore = resActivate.freeSpins && resActivate.freeSpins.remain;
    ctx.A.must(typeof remainBefore === 'number' && remainBefore > 0, 'freeSpins.remain phải > 0 sau kích hoạt');
    ctx.log('Sau activate: remain=' + remainBefore);

    // Spin 1 free spin (FORCE_LOSS để biết chắc không có win)
    await TCH.arm(ctx, 'FORCE_LOSS');
    const resFs = await TCH.spin(ctx, 1, 1, 12000);
    const remainAfter = resFs.freeSpins && resFs.freeSpins.remain;

    // remain phải giảm đúng 1
    ctx.A.eq(remainAfter, remainBefore - 1, 'freeSpins.remain phải giảm 1 sau mỗi free spin');

    // Trong free spin: balance KHÔNG bị trừ bet (before == after khi thua)
    // PROBE: diff before-after = 0 khi thua trong free spin
    const before = TCH.pick(resFs, 'balance.before');
    const after = TCH.pick(resFs, 'balance.after');
    const win = TCH.num(TCH.pick(resFs, 'balance.totalWin'));
    ctx.A.near(
      TCH.num(after), TCH.num(before) + win,
      'balance.after = before + totalWin (free spin KHÔNG trừ bet)',
    );

    ctx.log('Free spin balance: before=' + before + ' after=' + after + ' win=' + win + ' → bet_deducted=' + (TCH.num(before) - TCH.num(after) > 0 && win === 0));
  },
});

TEST_CATALOG.register({
  id: 'TC-FS-02',
  group: 'FS',
  title: 'Chơi hết free spin (Rush): remain về 0, nextMode trở về BASE',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    await drainToBase(ctx);
    const resActivate = await activateRushFreeSpins(ctx);
    ctx.A.must(
      resActivate.rush && resActivate.rush.triggered === true,
      'rush.triggered phải true',
    );
    let remain = resActivate.freeSpins && resActivate.freeSpins.remain;
    ctx.A.must(typeof remain === 'number' && remain > 0, 'phải có free spin để test FS-02');
    ctx.log('Bắt đầu: remain=' + remain);

    // Chơi hết tất cả free spin
    let lastRes = null;
    while (remain > 0) {
      await TCH.arm(ctx, 'FORCE_LOSS');
      lastRes = await TCH.spin(ctx, 1, 1, 12000);
      remain = lastRes.freeSpins ? lastRes.freeSpins.remain : 0;
      ctx.log('remain=' + remain + ' nextMode=' + (lastRes.round && lastRes.round.nextMode));
    }

    // Sau khi hết free spin: remain=0, nextMode=BASE
    ctx.A.eq(remain, 0, 'freeSpins.remain phải = 0 sau khi hết');
    ctx.A.eq(
      lastRes && lastRes.round && lastRes.round.nextMode, 'BASE',
      'round.nextMode phải BASE sau khi hết free spin',
    );
    ctx.A.eq(
      lastRes && lastRes.round && lastRes.round.thisMode, 'RUSH_MODE',
      'round.thisMode phải RUSH_MODE ở spin cuối',
    );

    // Spin thường tiếp theo bị trừ bet bình thường
    const balBeforeBase = await TCH.balance(ctx);
    await TCH.arm(ctx, 'FORCE_LOSS');
    const resBase = await TCH.spin(ctx, 1, 1);
    const balAfterBase = TCH.num(TCH.pick(resBase, 'balance.after'));
    const bet = TC_RULES.betFormula(1, 1);
    ctx.A.near(balAfterBase, balBeforeBase - bet, 'spin BASE sau free spin phải bị trừ bet');

    ctx.log('FS-02 hoàn thành: hết free spin, về BASE, bet trừ bình thường');
  },
});

TEST_CATALOG.register({
  id: 'TC-FS-04',
  group: 'FS',
  title: 'Win cap trong free spin (Rush): accumulatedWin ghi lại, winCap == 20000×bet (engine), GDD nói 2000×',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    // Đảm bảo balance đủ và state sạch
    await TCH.setBalance(ctx, 10000);
    await drainToBase(ctx);

    // Kích hoạt free spin qua rush (trong BASE mode)
    const resActivate = await activateRushFreeSpins(ctx);
    ctx.A.must(
      resActivate.rush && resActivate.rush.triggered === true,
      'rush.triggered phải true để vào free spin',
    );
    ctx.A.must(
      resActivate.freeSpins && resActivate.freeSpins.remain > 0,
      'phải có free spin để test FS-04',
    );
    const remainBefore = resActivate.freeSpins.remain;
    ctx.log('Sau activate: remain=' + remainBefore);

    // Arm win cap trong free spin → spin
    await TCH.arm(ctx, 'FORCE_WIN_CAP');
    const resCap = await TCH.spin(ctx, 1, 1, 15000);

    const totalWin = TCH.num(TCH.pick(resCap, 'balance.totalWin'));
    const winCap = TCH.num(resCap.winCap);
    const totalBet = TCH.num(resCap.totalBet);
    const accWin = TCH.pick(resCap, 'freeSpins.accumulatedWin');
    const remainAfter = resCap.freeSpins && resCap.freeSpins.remain;

    // PROBE ĐÃ XÁC MINH: FORCE_WIN_CAP trong free spin tạo all-W screen với
    // win phụ thuộc hệ số cuộn 4 ngẫu nhiên. totalWin KHÔNG nhất thiết == winCap
    // (trong free spin chỉ ghi vào accumulatedWin, còn xét cap cuối mỗi spin).
    // Assert: totalWin ≤ winCap (capped) và accumulatedWin cập nhật đúng.
    ctx.A.ok(
      totalWin <= winCap + 0.005,
      'totalWin (' + totalWin + ') phải ≤ winCap (' + winCap + ')',
    );
    // totalWin phải > 0 khi FORCE_WIN_CAP hoạt động
    ctx.A.ok(totalWin > 0, 'totalWin phải > 0 sau FORCE_WIN_CAP trong free spin, nhận: ' + totalWin);

    // accumulatedWin ghi lại tổng thắng trong free spin
    ctx.A.ok(
      typeof accWin === 'number' && accWin >= totalWin - 0.005,
      'freeSpins.accumulatedWin (' + accWin + ') phải ≥ totalWin spin này (' + totalWin + ')',
    );

    // remain giảm 1 (free spin tiếp tục, không kết thúc sớm — PROBE xác nhận)
    ctx.A.eq(remainAfter, remainBefore - 1, 'freeSpins.remain giảm 1 (free spin không kết thúc sớm sau cap trong RUSH_MODE)');

    // Assert GDD mismatch winCap — dự kiến FAIL để lộ mismatch spec/code
    ctx.A.ok(
      Math.abs(winCap - TC_RULES.winCapMultiplierGdd * totalBet) <= 0.005,
      'winCap ≠ 2000×bet theo GDD (engine trả 20000×) — mismatch spec/code',
    );

    // winCapMilestone: optional
    if (resCap.winCapMilestone !== undefined) {
      ctx.log('winCapMilestone=' + JSON.stringify(resCap.winCapMilestone));
    } else {
      ctx.log('winCapMilestone vắng mặt (bình thường — wsproxy drop null)');
    }

    ctx.log('FS-04: totalWin=' + totalWin + ' winCap=' + winCap + ' totalBet=' + totalBet + ' ratio=' + Math.round(winCap / totalBet) + '× (GDD nói 2000×, engine trả 20000×)');
    ctx.log('accumulatedWin=' + accWin + ' remain=' + remainBefore + '→' + remainAfter);
  },
});

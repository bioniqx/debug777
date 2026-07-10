/* ════════════════════════════════════════════════════════════════
   CASES — ECONOMY: BULK, VAULT, HIST, JHIST
   (Phần A ưu tiên Cao trong TEST_CASES.md)
   Xem quy ước chung ở đầu cases-core.js.
   ════════════════════════════════════════════════════════════════ */

/* ── BULK ────────────────────────────────────────────────────── */

// Helper: drain bất kỳ bulk session nào đang hoạt động trước khi mua mới
async function drainExistingBulk(ctx, remainingSpins) {
  if (!remainingSpins || remainingSpins <= 0) return;
  ctx.log('Drain ' + remainingSpins + ' spin bulk còn lại từ session trước...');
  const deadline = Date.now() + 45000;
  for (let i = 0; i < remainingSpins && Date.now() < deadline; i++) {
    ctx.ws.sendCmd({ cmd: 1500, betLevelId: '1', coinValueId: '1' });
    try {
      const msg = await ctx.ws.waitFor(
        (m) => m.cmd === 1500 && m.payload && m.payload.screen !== undefined,
        Math.min(8000, deadline - Date.now()),
        'drain bulk spin #' + (i + 1)
      );
      if (msg.payload.bulk && msg.payload.bulk.packComplete === true) break;
    } catch (e) {
      break;
    }
  }
}

TEST_CATALOG.register({
  id: 'TC-BULK-01',
  group: 'BULK',
  title: 'Mua gói MULTI_PACK (10 spin): trừ đúng tiền, client-driven 10 spin',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Drain bất kỳ session bulk còn sót từ lần chạy trước
    await drainExistingBulk(ctx, ctx.joined.bulkSpinsRemaining || 0);

    // Đảm bảo đủ tiền (cost = 40)
    await TCH.setBalance(ctx, 500);
    const balance0 = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5
    const cost = TC_RULES.bulkPacks.MULTI_PACK.costMult * bet; // 8 × 5 = 40

    // Mua gói: server trả reply 1511 {activated, cost, spins, balanceAfter}
    // (KHÔNG tự push spin — client phải gửi từng cmd 1500)
    ctx.ws.sendCmd({
      cmd: 1511,
      packType: 'MULTI_PACK',
      betLevelId: '1',
      coinValueId: '1',
    });
    const activateMsg = await ctx.ws.waitFor(1511, ctx.cfg.timeoutMs, 'bulk-buy activate (cmd 1511)');
    ctx.A.ok(!TCH.isRejection(activateMsg), 'mua bulk không được lỗi: ' + TCH.errorCode(activateMsg));
    ctx.log('bulk activate reply: ' + JSON.stringify(activateMsg.payload));
    ctx.A.eq(activateMsg.payload.activated, true, 'activated == true');
    ctx.A.near(TCH.num(activateMsg.payload.cost), cost, 'cost == 40');

    // Balance bị trừ ngay lúc mua (balanceAfter trong reply)
    ctx.A.near(TCH.num(activateMsg.payload.balanceAfter), balance0 - cost, 'balanceAfter sau mua = trước − 40');

    // Spin từng ván một (client-driven); chạy đến khi packComplete=true
    const spins = [];
    const BUDGET_MS = 45000;
    const PER_SPIN_MS = 8000;
    const totalSpins = TC_RULES.bulkPacks.MULTI_PACK.spins; // 10 theo spec
    const deadline = Date.now() + BUDGET_MS;

    for (let i = 0; Date.now() < deadline; i++) {
      ctx.ws.sendCmd({ cmd: 1500, betLevelId: '1', coinValueId: '1' });
      try {
        const msg = await ctx.ws.waitFor(
          (m) => m.cmd === 1500 && m.payload && m.payload.screen !== undefined,
          Math.min(PER_SPIN_MS, deadline - Date.now()),
          'spin bulk #' + (i + 1)
        );
        spins.push(msg.payload);
        if (msg.payload.bulk && msg.payload.bulk.packComplete === true) break;
      } catch (e) {
        ctx.log('Timeout chờ spin #' + (i + 1) + ': ' + e.message);
        break;
      }
    }

    ctx.log('Số spin nhận được: ' + spins.length);
    const lastSpin = spins[spins.length - 1];
    if (lastSpin) {
      ctx.log('bulk trên spin cuối: ' + JSON.stringify(lastSpin.bulk));
    }

    ctx.A.ok(spins.length >= totalSpins, 'phải nhận đủ ≥ 10 spin push, nhận: ' + spins.length);

    // Balance cuối = balance0 − cost + tổng win (cost đã trừ tại thời điểm mua)
    const totalWin = spins.reduce((s, r) => s + TCH.num(TCH.pick(r, 'balance.totalWin')), 0);
    const balanceAfter = await TCH.balance(ctx);
    ctx.A.near(balanceAfter, balance0 - cost + totalWin, 'balance cuối = trước − 40 + tổng win');

    ctx.A.ok(
      lastSpin && lastSpin.bulk && lastSpin.bulk.packComplete === true,
      'spin cuối phải có bulk.packComplete == true'
    );

    if (lastSpin && lastSpin.bulk && lastSpin.bulk.summary) {
      ctx.A.eq(lastSpin.bulk.summary.packType, 'MULTI_PACK', 'summary.packType');
      // summary.cost là {} (wsproxy drop null-numeric field) — chỉ log, không assert giá trị
      ctx.log('summary.cost (có thể là {} nếu wsproxy drop): ' + JSON.stringify(lastSpin.bulk.summary.cost));
    } else {
      ctx.log('bulk.summary vắng mặt trên spin cuối (trường tùy chọn)');
    }
  },
});

TEST_CATALOG.register({
  id: 'TC-BULK-02',
  group: 'BULK',
  title: 'Mua gói SUPER_MULTI_PACK (55 spin): trừ đúng tiền, client-driven 55 spin',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Drain bất kỳ session bulk còn sót từ lần chạy trước
    await drainExistingBulk(ctx, ctx.joined.bulkSpinsRemaining || 0);

    // Đảm bảo đủ tiền (cost = 200)
    await TCH.setBalance(ctx, 1000);
    const balance0 = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5
    const cost = TC_RULES.bulkPacks.SUPER_MULTI_PACK.costMult * bet; // 40 × 5 = 200

    // Mua gói: reply 1511 {activated, cost, spins, balanceAfter}
    ctx.ws.sendCmd({
      cmd: 1511,
      packType: 'SUPER_MULTI_PACK',
      betLevelId: '1',
      coinValueId: '1',
    });
    const activateMsg = await ctx.ws.waitFor(1511, ctx.cfg.timeoutMs, 'bulk-buy activate SUPER (cmd 1511)');
    ctx.A.ok(!TCH.isRejection(activateMsg), 'mua super bulk không được lỗi: ' + TCH.errorCode(activateMsg));
    ctx.log('super bulk activate: ' + JSON.stringify(activateMsg.payload));
    ctx.A.eq(activateMsg.payload.activated, true, 'activated == true');
    ctx.A.near(TCH.num(activateMsg.payload.cost), cost, 'cost == 200');
    ctx.A.near(TCH.num(activateMsg.payload.balanceAfter), balance0 - cost, 'balanceAfter sau mua = trước − 200');

    // Client-driven: gửi cmd 1500 cho đến khi packComplete=true (hoặc hết budget)
    const spins = [];
    const BUDGET_MS = 120000;
    const PER_SPIN_MS = 8000;
    const totalSpins = TC_RULES.bulkPacks.SUPER_MULTI_PACK.spins; // 55 theo spec
    const deadline = Date.now() + BUDGET_MS;

    // Chạy cho đến khi packComplete=true; không cap số vòng cứng (server báo khi nào xong)
    for (let i = 0; Date.now() < deadline; i++) {
      ctx.ws.sendCmd({ cmd: 1500, betLevelId: '1', coinValueId: '1' });
      try {
        const msg = await ctx.ws.waitFor(
          (m) => m.cmd === 1500 && m.payload && m.payload.screen !== undefined,
          Math.min(PER_SPIN_MS, deadline - Date.now()),
          'spin super bulk #' + (i + 1)
        );
        spins.push(msg.payload);
        if (msg.payload.bulk && msg.payload.bulk.packComplete === true) break;
      } catch (e) {
        ctx.log('Timeout chờ spin #' + (i + 1) + ': ' + e.message);
        break;
      }
    }

    ctx.log('Số spin nhận được: ' + spins.length);
    const lastSpin = spins[spins.length - 1];
    if (lastSpin) {
      ctx.log('bulk trên spin cuối: ' + JSON.stringify(lastSpin.bulk));
    }

    // Phải nhận đủ ít nhất totalSpins spin push
    ctx.A.ok(spins.length >= totalSpins, 'phải nhận đủ ≥ 55 spin push, nhận: ' + spins.length);

    const totalWin = spins.reduce((s, r) => s + TCH.num(TCH.pick(r, 'balance.totalWin')), 0);
    const balanceAfter = await TCH.balance(ctx);
    ctx.A.near(balanceAfter, balance0 - cost + totalWin, 'balance cuối = trước − 200 + tổng win');

    ctx.A.ok(
      lastSpin && lastSpin.bulk && lastSpin.bulk.packComplete === true,
      'spin cuối phải có bulk.packComplete == true'
    );

    if (lastSpin && lastSpin.bulk && lastSpin.bulk.summary) {
      ctx.A.eq(lastSpin.bulk.summary.packType, 'SUPER_MULTI_PACK', 'summary.packType');
      ctx.log('summary.cost (có thể là {} nếu wsproxy drop): ' + JSON.stringify(lastSpin.bulk.summary.cost));
    } else {
      ctx.log('bulk.summary vắng mặt trên spin cuối (trường tùy chọn)');
    }
  },
});

TEST_CATALOG.register({
  id: 'TC-BULK-06',
  group: 'BULK',
  title: 'Mua bulk khi số dư không đủ bị từ chối, balance không đổi',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await TCH.setBalance(ctx, 30);
    const before = await TCH.balance(ctx);
    ctx.A.near(before, 30, 'balance ban đầu = 30');

    // cost = 8 × 5 = 40 > 30 → phải bị từ chối
    const r = await TCH.expectReject(ctx, {
      cmd: 1511,
      packType: 'MULTI_PACK',
      betLevelId: '1',
      coinValueId: '1',
    }, 5000);

    ctx.A.ok(r.rejected, 'mua bulk khi thiếu tiền phải bị từ chối');
    if (!r.silent) {
      ctx.A.eq(r.code, 'INSUFFICIENT_BALANCE', 'mã lỗi phải là INSUFFICIENT_BALANCE');
    } else {
      ctx.log('Từ chối im lặng (không push error frame)');
    }

    const after = await TCH.balance(ctx);
    ctx.A.near(after, 30, 'balance không đổi sau khi bị từ chối');
  },
});

/* ── VAULT ───────────────────────────────────────────────────── */

// Helper: thu hồi bất kỳ vault đang pending (đã mua) trước khi test
async function drainPendingVault(ctx) {
  // Thử mở vault; nếu không có vault pending thì server trả NO_VAULT_PURCHASE (lỗi) — bỏ qua
  ctx.ws.sendCmd({ cmd: 1513 });
  try {
    const openMsg = await ctx.ws.waitFor(
      (m) => m.cmd === 1513,
      3000, 'drain vault-open'
    );
    if (!TCH.isRejection(openMsg)) {
      // Có vault pending đang mở — collect luôn
      ctx.log('Drain vault pending: collect...');
      ctx.ws.sendCmd({ cmd: 1514, accept: false });
      await ctx.ws.waitFor(1514, 3000, 'drain vault-collect');
    }
    // Nếu mua rồi chưa mở, thử mở + collect tiếp
  } catch (e) {
    // Timeout hoặc lỗi — bỏ qua, vault có thể không pending
  }
  // Nếu vẫn còn pending từ việc đã mua mà chưa mở: thử open rồi collect
  ctx.ws.sendCmd({ cmd: 1513 });
  try {
    const openMsg2 = await ctx.ws.waitFor(
      (m) => m.cmd === 1513,
      3000, 'drain vault-open 2'
    );
    if (!TCH.isRejection(openMsg2)) {
      ctx.ws.sendCmd({ cmd: 1514, accept: false });
      await ctx.ws.waitFor(1514, 3000, 'drain vault-collect 2');
    }
  } catch (e) {
    // không có gì pending nữa — OK
  }
}

TEST_CATALOG.register({
  id: 'TC-VAULT-01',
  group: 'VAULT',
  title: 'Mua Vault BRONZE: trừ đúng 75 (15×5), nhận reply xác nhận mua',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Drain bất kỳ vault đang pending từ lần chạy trước
    await drainPendingVault(ctx);

    // Đảm bảo đủ tiền để mua (cost = 75)
    await TCH.setBalance(ctx, 500);
    const balance0 = await TCH.balance(ctx);
    const bet = TC_RULES.betFormula(1, 1); // 5
    const cost = TC_RULES.vaultCost.BRONZE * bet; // 15 × 5 = 75

    ctx.ws.sendCmd({
      cmd: 1512,
      chestType: 'BRONZE',
      betLevelId: '1',
      coinValueId: '1',
    });

    // Chờ reply cmd 1512
    const msg = await ctx.ws.waitFor(1512, ctx.cfg.timeoutMs, 'reply vault-buy (cmd 1512)');
    ctx.A.ok(!TCH.isRejection(msg), 'mua vault không được trả lỗi: ' + TCH.errorCode(msg));
    ctx.log('vault-buy reply shape: ' + JSON.stringify(msg.payload));

    // Số dư phải giảm đúng cost
    const after = await TCH.balance(ctx);
    ctx.A.near(after, balance0 - cost, 'balance sau mua = trước − 75');
  },
});

TEST_CATALOG.register({
  id: 'TC-VAULT-03',
  group: 'VAULT',
  title: 'Mở Vault sau khi mua BRONZE: có screen, có win, canDoubleUp == true',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await drainPendingVault(ctx);
    // Đảm bảo đủ tiền để mua
    await TCH.setBalance(ctx, 500);

    // Mua BRONZE trước
    ctx.ws.sendCmd({
      cmd: 1512,
      chestType: 'BRONZE',
      betLevelId: '1',
      coinValueId: '1',
    });
    await ctx.ws.waitFor(1512, ctx.cfg.timeoutMs, 'vault-buy xong');

    // Mở vault
    ctx.ws.sendCmd({ cmd: 1513 });
    const msg = await ctx.ws.waitFor(1513, ctx.cfg.timeoutMs, 'vault-open (cmd 1513)');
    ctx.A.ok(!TCH.isRejection(msg), 'mở vault không được trả lỗi: ' + TCH.errorCode(msg));

    const p = msg.payload;
    ctx.log('vault-open reply: ' + JSON.stringify(p));

    ctx.A.ok(p.screen !== undefined, 'reply mở vault phải có screen');
    ctx.A.ok(Array.isArray(p.wins) && p.wins.length >= 1, 'phải có ít nhất 1 đường thắng');
    ctx.A.ok(TCH.num(p.totalWin) > 0, 'totalWin > 0');
    ctx.A.eq(p.canDoubleUp, true, 'canDoubleUp == true');

    // Thu hồi (không double up) để không ảnh hưởng case sau
    ctx.ws.sendCmd({ cmd: 1514, accept: false });
    await ctx.ws.waitFor(1514, ctx.cfg.timeoutMs, 'vault-collect');
  },
});

TEST_CATALOG.register({
  id: 'TC-VAULT-05',
  group: 'VAULT',
  title: 'Mua BRONZE → mở → từ chối double-up: nhận đúng số tiền thắng',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    await drainPendingVault(ctx);
    // Đảm bảo đủ tiền để mua
    await TCH.setBalance(ctx, 500);

    // Mua
    ctx.ws.sendCmd({
      cmd: 1512,
      chestType: 'BRONZE',
      betLevelId: '1',
      coinValueId: '1',
    });
    await ctx.ws.waitFor(1512, ctx.cfg.timeoutMs, 'vault-buy');

    // Mở
    ctx.ws.sendCmd({ cmd: 1513 });
    const openMsg = await ctx.ws.waitFor(1513, ctx.cfg.timeoutMs, 'vault-open');
    const totalWin = TCH.num(openMsg.payload.totalWin);
    ctx.log('vault totalWin = ' + totalWin);

    // Lấy balance trước khi collect
    const beforeCollect = await TCH.balance(ctx);

    // Từ chối double up → collect
    ctx.ws.sendCmd({ cmd: 1514, accept: false });
    const collectMsg = await ctx.ws.waitFor(1514, ctx.cfg.timeoutMs, 'vault-collect (cmd 1514)');
    const p = collectMsg.payload;
    ctx.log('vault-collect reply: ' + JSON.stringify(p));

    ctx.A.ok(!TCH.isRejection(collectMsg), 'collect không được trả lỗi');
    ctx.A.near(TCH.num(p.collected), totalWin, 'collected ≈ totalWin từ vault-open');
    ctx.A.eq(p.status, 'COLLECTED', 'status == COLLECTED');

    // Balance phải tăng đúng totalWin
    const afterCollect = await TCH.balance(ctx);
    ctx.A.near(afterCollect, beforeCollect + totalWin, 'balance sau collect = trước + totalWin');
  },
});

TEST_CATALOG.register({
  id: 'TC-VAULT-11',
  group: 'VAULT',
  title: 'Mở vault khi chưa mua bị từ chối với mã NO_VAULT_PURCHASE',
  async run(ctx) {
    await TCH.connectJoin(ctx);
    const before = await TCH.balance(ctx);

    const r = await TCH.expectReject(ctx, { cmd: 1513 }, 5000);
    ctx.A.ok(r.rejected, 'mở vault chưa mua phải bị từ chối');
    if (!r.silent) {
      ctx.A.eq(r.code, 'NO_VAULT_PURCHASE', 'mã lỗi phải là NO_VAULT_PURCHASE');
    } else {
      ctx.log('Từ chối im lặng (không có error push)');
    }

    const after = await TCH.balance(ctx);
    ctx.A.near(after, before, 'balance không đổi');
  },
});

/* ── HIST ────────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-HIST-01',
  group: 'HIST',
  title: 'Lịch sử spin (1504): sau 2 ván, phần tử mới nhất khớp round id',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Spin 2 lần để chắc chắn có lịch sử
    await TCH.arm(ctx, 'FORCE_LOSS');
    const res1 = await TCH.spin(ctx, 1, 1);
    ctx.log('spin 1 roundId: ' + TCH.pick(res1, 'round.id'));

    const res2 = await TCH.spin(ctx, 1, 1);
    const lastRoundId = TCH.pick(res2, 'round.id');
    ctx.log('spin 2 roundId: ' + lastRoundId);

    // Lấy lịch sử
    ctx.ws.sendCmd({ cmd: 1504, limit: 10, offset: 0 });
    const histMsg = await ctx.ws.waitFor(1504, ctx.cfg.timeoutMs, 'spin history (cmd 1504)');
    const p = histMsg.payload;
    ctx.log('history reply keys: ' + Object.keys(p || {}).join(', '));

    ctx.A.ok(Array.isArray(p.spins), 'reply phải có mảng spins');
    ctx.A.ok(p.spins.length >= 2, 'phải có ít nhất 2 spin trong lịch sử');

    // Phần tử đầu là mới nhất
    const newest = p.spins[0];
    ctx.log('newest spin entry: ' + JSON.stringify(newest));

    // Kiểm tra các field bắt buộc
    ctx.A.ok(newest.roundId !== undefined, 'phần tử lịch sử có roundId');
    ctx.A.ok(newest.betAmount !== undefined, 'phần tử lịch sử có betAmount');
    ctx.A.ok(newest.totalWin !== undefined, 'phần tử lịch sử có totalWin');
    ctx.A.ok(newest.profit !== undefined, 'phần tử lịch sử có profit');
    ctx.A.ok(newest.timestamp !== undefined, 'phần tử lịch sử có timestamp');
    ctx.A.ok(newest.mode !== undefined, 'phần tử lịch sử có mode');

    // roundId mới nhất khớp với spin cuối
    if (lastRoundId !== undefined) {
      ctx.A.eq(String(newest.roundId), String(lastRoundId), 'roundId mới nhất khớp spin cuối');
    } else {
      ctx.log('round.id vắng mặt trong spin result — không assert roundId');
    }
  },
});

/* ── JHIST ───────────────────────────────────────────────────── */

TEST_CATALOG.register({
  id: 'TC-JHIST-01',
  group: 'JHIST',
  title: 'Lịch sử jackpot (1507): chỉ có GRAND/MAJOR, không có MINOR; entry mới nhất khớp win',
  async run(ctx) {
    await TCH.connectJoin(ctx);

    // Arm FORCE_JACKPOT GRAND rồi armTreasureRoom để pick jackpot
    // (PROBE: cần arm jackpot GRAND để entry vào lịch sử; MINOR không xuất hiện)
    await TCH.arm(ctx, 'FORCE_JACKPOT', { tier: 'GRAND' });
    const trRoom = await ctx.api.armTreasureRoom();
    ctx.log('armTreasureRoom result: ' + JSON.stringify(trRoom));

    // Pick jackpot
    ctx.ws.sendCmd({ cmd: 1515, chest: 'BRONZE' });
    const pickMsg = await ctx.ws.waitFor(1515, ctx.cfg.timeoutMs, 'jackpot pick (cmd 1515)');
    ctx.A.ok(!TCH.isRejection(pickMsg), 'jackpot pick không được trả lỗi: ' + TCH.errorCode(pickMsg));

    const pickPayload = pickMsg.payload;
    ctx.log('jackpot pick reply: ' + JSON.stringify(pickPayload));

    const wonTier = pickPayload.wonTier;
    const wonAmount = TCH.num(pickPayload.amount);
    ctx.log('wonTier=' + wonTier + ', amount=' + wonAmount);

    // Lấy lịch sử jackpot
    ctx.ws.sendCmd({ cmd: 1507, limit: 10 });
    const histMsg = await ctx.ws.waitFor(1507, ctx.cfg.timeoutMs, 'jackpot history (cmd 1507)');
    const h = histMsg.payload;
    ctx.log('jackpot history reply: ' + JSON.stringify(h).slice(0, 300));

    ctx.A.ok(Array.isArray(h.history), 'reply phải có mảng history');

    // Kiểm tra không có MINOR trong lịch sử
    const hasMinor = h.history.some((e) => e.jackpotType === 'MINOR');
    ctx.A.ok(!hasMinor, 'lịch sử jackpot không được có entry MINOR');

    // Mỗi entry phải có các field chuẩn
    h.history.forEach((e, i) => {
      ctx.A.ok(e.userName !== undefined, 'entry[' + i + '] có userName');
      ctx.A.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date || ''), 'entry[' + i + '] date dạng YYYY-MM-DD');
      ctx.A.ok(e.amount !== undefined, 'entry[' + i + '] có amount');
      ctx.A.ok(e.jackpotType === 'GRAND' || e.jackpotType === 'MAJOR',
        'entry[' + i + '] jackpotType ∈ {GRAND, MAJOR}, nhận: ' + e.jackpotType);
    });

    // Nếu vừa thắng GRAND, entry mới nhất phải khớp
    if (wonTier === 'GRAND' && h.history.length > 0) {
      const newest = h.history[0];
      ctx.A.eq(newest.jackpotType, 'GRAND', 'entry mới nhất phải là GRAND');
      ctx.A.near(TCH.num(newest.amount), wonAmount, 'amount entry mới nhất ≈ wonAmount');
    } else {
      ctx.log('wonTier=' + wonTier + ', không assert entry mới nhất');
    }
  },
});

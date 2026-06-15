const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ═══════════════════════════════════════════════════════════
//  Rate Limiting (in-memory per isolate)
// ═══════════════════════════════════════════════════════════
const _rateLimits = new Map();

function isRateLimited(userId, action, windowMs) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const last = _rateLimits.get(key);
  if (last && (now - last) < windowMs) return true;
  _rateLimits.set(key, now);
  return false;
}
// ═══════════════════════════════════════════════════════════
//  DURABLE OBJECT — DepositChecker
//  واحد لكل مستخدم — يعمل داخل Cloudflare بغض النظر عن المتصفح
// ═══════════════════════════════════════════════════════════
export class DepositChecker {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // /start → بدء فحص جديد أو إرجاع الحالي
    if (url.pathname === "/start" && request.method === "POST") {
      const currentStatus = await this.state.storage.get("status");

      // فحص نشط → لا تنشئ جديداً
      if (currentStatus === "pending") {
        return Response.json({ ok: true, status: "pending", alreadyRunning: true });
      }

      const { userId, comment } = await request.json();

      await this.state.storage.put("userId",    userId);
      await this.state.storage.put("comment",   String(comment));
      await this.state.storage.put("status",    "pending");
      await this.state.storage.put("startTime", Date.now());
      await this.state.storage.put("attempts",  0);
      await this.state.storage.delete("amount");

      // أول فحص بعد 5 ثوانٍ
      await this.state.storage.setAlarm(Date.now() + 5_000);

      return Response.json({ ok: true, status: "pending" });
    }

    // /status → إرجاع الحالة الحالية
    if (url.pathname === "/status" && request.method === "GET") {
      const status = await this.state.storage.get("status") ?? "idle";
      const amount = await this.state.storage.get("amount")  ?? null;
      return Response.json({ status, amount });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

async alarm() {
  const userId    = await this.state.storage.get("userId");
  const comment   = await this.state.storage.get("comment");
  const startTime = await this.state.storage.get("startTime");
  let   attempts  = (await this.state.storage.get("attempts")) || 0;

  const MAX_ATTEMPTS = 8;
  attempts++;
  await this.state.storage.put("attempts", attempts);

  if (Date.now() - startTime > 120_000) {
    await this.state.storage.put("status", "timeout");
    return;
  }

  const depositAddress = this.env.DEPOSIT_ADDRESS || "";
  const headers = { "Accept": "application/json" };
  if (this.env.TONCENTER_API_KEY) headers["X-API-Key"] = this.env.TONCENTER_API_KEY;

  try {
    const tonRes = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(depositAddress)}&limit=7&archival=false`,
      { headers }
    );

    if (!tonRes.ok) {
      throw new Error(`TonCenter HTTP ${tonRes.status}`);
    }

    const tonData = await tonRes.json();

    if (tonData?.ok && Array.isArray(tonData.result)) {
      for (const tx of tonData.result) {
        const inMsg = tx.in_msg;
        if (!inMsg) continue;
        if (!inMsg.value || Number(inMsg.value) === 0) continue;

        let txComment = "";
        if (typeof inMsg.message === "string" && inMsg.message.length > 0) {
          txComment = inMsg.message;
        } else {
          const msgData = inMsg.msg_data;
          if (msgData?.["@type"] === "msg.dataText" && msgData.text) {
            try {
              const raw = atob(msgData.text);
              txComment = raw.replace(/^\x00+/, "");
            } catch (e) {
              txComment = "";
            }
          }
        }

        if (txComment.trim() !== String(comment).trim()) continue;

        const txHash = tx.transaction_id?.hash;
        if (!txHash) continue;

        const existing = await this.env.DB.prepare(
          "SELECT 1 FROM deposits WHERE tx_hash=?"
        ).bind(txHash).first();

        if (existing) {
          await this.state.storage.put("status", "already_processed");
          await this.state.storage.put("amount", Number(inMsg.value) / 1e9);
          return;
        }

        const amount = Number(inMsg.value) / 1e9;

        if (amount < 0.1) {
          await this.state.storage.put("status", "below_minimum");
          await this.state.storage.put("amount", amount);
          return;
        }

        // ── قراءة بيانات المستخدم قبل التحديث (للتسوية + referrer_id في استعلام واحد) ──
        const userRow = await this.env.DB.prepare(
          "SELECT deposit_amount, last_claim, referrer_id FROM users WHERE id=?"
        ).bind(userId).first();

        if (!userRow) { continue; }

        const minedOld = computeMined(userRow);
        const settleNow = Date.now();

        try {
          const batchRes = await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE users SET balance=balance+?, deposit_amount=deposit_amount+?, last_claim=? WHERE id=? AND last_claim=?"
            ).bind(minedOld, amount, settleNow, userId, userRow.last_claim),
            this.env.DB.prepare(
              "INSERT INTO deposits(user_id, tx_hash, amount, status, created_at, memo) VALUES(?, ?, ?, 'confirmed', ?, ?)"
            ).bind(userId, txHash, amount, Date.now(), comment),
          ]);

          // ── fallback: لو last_claim تغيّر بالتوازي (claim حدث في اللحظة نفسها) ──
          if (batchRes[0].meta.changes === 0) {
            await this.env.DB.prepare(
              "UPDATE users SET deposit_amount=deposit_amount+? WHERE id=?"
            ).bind(amount, userId).run();
          }
        } catch (e) {
          const errMsg = String(e?.message || e).toLowerCase();
          await this.state.storage.put("lastError", errMsg);

          if (errMsg.includes("unique")) {
            await this.state.storage.put("status", "already_processed");
            await this.state.storage.put("amount", amount);
            return;
          }

          continue;
        }

        // منح المُحيل 10% من قيمة الإيداع
        try {
          if (userRow?.referrer_id) {
            await this.env.DB.prepare("UPDATE users SET referral_rewards=referral_rewards+? WHERE id=?")
              .bind(amount * 0.10, userRow.referrer_id).run();
          }
        } catch {}

        await this.state.storage.put("status", "found");
        await this.state.storage.put("amount", amount);
        await this.notifyUser(userId, amount);
        return;
      }
    } else {  
    }
  } catch (e) {
  }

  if (attempts < MAX_ATTEMPTS) {
    await this.state.storage.setAlarm(Date.now() + 15_000);
  } else {
    await this.state.storage.put("status", "timeout");
  }
}

  async notifyUser(userId, amount) {
    if (!this.env.BOT_TOKEN) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text:
            `✅ <b>Deposit Confirmed!</b>\n\n` +
            `💰 Amount: <b>${amount.toFixed(4)} TON</b>\n` +
            `📈 Daily earnings: <b>+${(amount * 0.10).toFixed(4)} TON/day</b>\n\n` +
            `⛏️ Your mining speed has been updated!`,
          parse_mode: "HTML",
        }),
      });
    } catch {}
  }
}

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════

async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

function toHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computed = await hmacSha256(secret, dataCheckString);
  if (toHex(computed) !== hash) return null;
  const userRaw = params.get("user");
  if (!userRaw) return null;
  try { return JSON.parse(userRaw); } catch { return null; }
}

async function getOrCreateUser(env, tgUser, referrerId) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
  if (row) return row;
  let ref = null;
  if (referrerId && Number(referrerId) !== tgUser.id) ref = Number(referrerId);
  await env.DB.prepare(
    "INSERT INTO users(id,username,first_name,balance,mined,last_claim,deposit_amount,referrer_id,created_at) VALUES(?,?,?,0,0,?,0.03,?,?)"
  ).bind(tgUser.id, tgUser.username || null, tgUser.first_name || null, now, ref, now).run();
  if (ref) {
    await env.DB.prepare("UPDATE users SET friends_count=friends_count+1 WHERE id=?").bind(ref).run();
  }
  return await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
}

function getTodayUTCStart() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function computeMined(user) {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - (user.last_claim || now));
  const depositAmount = user.deposit_amount || 0;
  const dailyEarning = depositAmount * 0.10;
  const perMs = dailyEarning / (24 * 60 * 60 * 1000);
  return elapsedMs * perMs;
}

async function notifyChannel(env, text) {
  if (!env.BOT_TOKEN || !env.ADMIN_CHANNEL_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.ADMIN_CHANNEL_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}

async function auth(request, env) {
  const initData = request.headers.get("X-Init-Data") || "";
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user) return null;
  return user;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      const FEE = Number(env.NETWORK_FEE || 1);

      if (url.pathname === "/api/init") return json({ ok: true });

      // me
      if (url.pathname === "/api/me" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await getOrCreateUser(env, tgUser, body.ref);
if (tgUser.photo_url && tgUser.photo_url !== user.photo_url) {
  await env.DB.prepare("UPDATE users SET photo_url=? WHERE id=?")
    .bind(tgUser.photo_url, tgUser.id).run();
}
const mined = computeMined(user);

return json({
  user: {
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    balance: user.balance,
    mined,
    last_claim: user.last_claim,
    deposit_amount: user.deposit_amount || 0,
    created_at: user.created_at,
    total_withdrawn: user.total_withdrawn || 0,
  },
  config: { fee: FEE, bot_username: env.BOT_USERNAME || "" },
});
      }

      // claim
      if (url.pathname === "/api/claim" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "claim", 3000)) return json({ error: "rate_limited" }, 429);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        const mined = computeMined(user);
if (mined < 0.1) return json({ error: "min_collect_0.1" }, 400);
const now = Date.now();
const claimResult = await env.DB.prepare(
  "UPDATE users SET balance=balance+?, last_claim=?, last_collect_at=? WHERE id=? AND last_claim=?"
).bind(mined, now, now, user.id, user.last_claim).run();

if (claimResult.meta.changes === 0) 
  return json({ error: "already_claimed" }, 400);

return json({ ok: true, claimed: mined, balance: user.balance + mined });
      }

      // friends
      if (url.pathname === "/api/friends" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, username, first_name, created_at, deposit_amount FROM users WHERE referrer_id=? ORDER BY created_at DESC LIMIT 100"
        ).bind(tgUser.id).all();
        const meRow = await env.DB.prepare(
          "SELECT referral_rewards, friends_count FROM users WHERE id=?"
        ).bind(tgUser.id).first();
        return json({
          friends: results,
          link: `https://t.me/${env.BOT_USERNAME || "your_bot"}/app?startapp=${tgUser.id}`,
          referral_rewards: meRow?.referral_rewards || 0,
          friends_count: meRow?.friends_count || 0,
        });
      }

      // deposit info
      if (url.pathname === "/api/deposit" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        return json({ address: env.DEPOSIT_ADDRESS || "", memo: String(tgUser.id) });
      }

      // ════ deposit/check → يُشغّل DO ════
      if (url.pathname === "/api/deposit/check" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (!env.DEPOSIT_ADDRESS) return json({ error: "deposit_not_configured" }, 500);

        const doId   = env.DEPOSIT_CHECKER.idFromName(`user_${tgUser.id}`);
        const doStub = env.DEPOSIT_CHECKER.get(doId);

        const doRes = await doStub.fetch("http://do/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: tgUser.id, comment: String(tgUser.id) }),
        });
        return new Response(doRes.body, {
          status: doRes.status,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // ════ deposit/status → يجلب حالة DO ════
      if (url.pathname === "/api/deposit/status" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);

        const doId   = env.DEPOSIT_CHECKER.idFromName(`user_${tgUser.id}`);
        const doStub = env.DEPOSIT_CHECKER.get(doId);

        const doRes = await doStub.fetch("http://do/status");
        return new Response(doRes.body, {
          status: doRes.status,
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // ════ deposit/history → آخر 5 إيداعات ════
      if (url.pathname === "/api/deposit/history" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);

        const { results } = await env.DB.prepare(
          "SELECT id, amount, status, created_at FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 5"
        ).bind(tgUser.id).all();
        return json({ deposits: results });
      }

// withdraw history
      if (url.pathname === "/api/withdraw/history" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, amount, fee, net, address, status, created_at FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 5"
        ).bind(tgUser.id).all();
        return json({ withdrawals: results });
      }
      
      // reinvest
      if (url.pathname === "/api/reinvest" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "reinvest", 3000)) return json({ error: "rate_limited" }, 429);
        const { amount } = await request.json();
        const amt = Number(amount);
        if (!amt || amt < 0.1) return json({ error: "min_reinvest_0.1" }, 400);
        // ── قراءة بيانات المستخدم لحساب الـ mined القديم قبل التحديث ──
        const userRow = await env.DB.prepare(
          "SELECT balance, deposit_amount, last_claim FROM users WHERE id=?"
        ).bind(tgUser.id).first();
        if (!userRow) return json({ error: "user_not_found" }, 404);

        const minedOld = computeMined(userRow);
        const now = Date.now();
        const netDelta = minedOld - amt; // خصم amt + إضافة mined القديم

        const deductResult = await env.DB.prepare(
          "UPDATE users SET balance=balance+?, deposit_amount=deposit_amount+?, total_reinvested=COALESCE(total_reinvested,0)+?, last_claim=? WHERE id=? AND balance>=? AND last_claim=?"
        ).bind(netDelta, amt, amt, now, tgUser.id, amt, userRow.last_claim).run();

        if (deductResult.meta.changes === 0) {
          // fallback: قد يكون last_claim تغيّر بالتوازي (claim حدث في اللحظة نفسها)
          const retry = await env.DB.prepare(
            "UPDATE users SET balance=balance-?, deposit_amount=deposit_amount+?, total_reinvested=COALESCE(total_reinvested,0)+? WHERE id=? AND balance>=?"
          ).bind(amt, amt, amt, tgUser.id, amt).run();

          if (retry.meta.changes === 0)
            return json({ error: "insufficient_balance" }, 400);
        }

        const reTxHash = `reinvest_${tgUser.id}_${Date.now()}`;
        await env.DB.prepare(
          "INSERT INTO deposits(user_id, tx_hash, amount, status, created_at, memo) VALUES(?,?,?,'reinvested',?,?)"
        ).bind(tgUser.id, reTxHash, amt, Date.now(), 'Reinvest').run();

        const updatedUser = await env.DB.prepare("SELECT balance, deposit_amount FROM users WHERE id=?").bind(tgUser.id).first();
        return json({ ok: true, deposit_amount: updatedUser.deposit_amount, balance: updatedUser.balance });
      }

      // withdraw
      if (url.pathname === "/api/withdraw" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "withdraw", 10000)) return json({ error: "rate_limited" }, 429);
        const { amount, address, memo } = await request.json();
        const amt = Number(amount);
        if (!amt || amt < 0.2 || !address) return json({ error: "invalid_input" }, 400);
        const fee10    = amt * 0.10;
        const feeFixed = 0.1;
        const totalFee = fee10 + feeFixed;
        const net      = amt - totalFee;
        if (net <= 0) return json({ error: "amount_too_small" }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (!user) return json({ error: "user_not_found" }, 404);
        if (user.balance < amt) return json({ error: "insufficient_balance" }, 400);
        const memoText = (memo && memo.trim()) ? memo.trim() : "Vault Miner";
        let displayName;
        if (tgUser.username)        displayName = `@${tgUser.username}`;
        else if (tgUser.first_name) displayName = tgUser.first_name;
        else                        displayName = `ID: ${tgUser.id}`;
        const deductResult = await env.DB.prepare(
  "UPDATE users SET balance=balance-? WHERE id=? AND balance>=?"
).bind(amt, tgUser.id, amt).run();

if (deductResult.meta.changes === 0) 
  return json({ error: "insufficient_balance" }, 400);

const insertResult = await env.DB.prepare(
  "INSERT INTO withdrawals(user_id,amount,fee,net,address,memo,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)"
).bind(tgUser.id, amt, totalFee, net, address, memoText, Date.now()).run();

const withdrawalId = insertResult.meta.last_row_id;
        const notifText =
          `🔴 <b>Withdrawal Request</b>\n\n` +
          `👤 ${displayName}\n` +
          `🆔 <code>${tgUser.id}</code>\n` +
          `💰 Amount: <b>${amt} TON</b>\n` +
          `📊 Fee: <b>${totalFee.toFixed(4)} TON</b>\n` +
          `💵 Net to send: <b>${net.toFixed(4)} TON</b>\n` +
          `📍 Address: <code>${address}</code>\n` +
          `📝 Memo: ${memoText}\n\n` +
          `👉 @VaultMiningBot ~ Earn 10% Daily Ton`;
        if (env.BOT_TOKEN && env.ADMIN_CHANNEL_ID) {
          try {
            const msgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: env.ADMIN_CHANNEL_ID,
                text: notifText,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: {
                  inline_keyboard: [[
                    { text: "✅ Approve", callback_data: `approve_${withdrawalId}` },
                    { text: "❌ Reject",  callback_data: `reject_${withdrawalId}`  },
                  ]],
                },
              }),
            });
            const msgData = await msgRes.json();
            if (msgData.ok) {
              await env.DB.prepare("UPDATE withdrawals SET message_id=?, chat_id=? WHERE id=?")
                .bind(msgData.result.message_id, String(env.ADMIN_CHANNEL_ID), withdrawalId).run();
            }
          } catch {}
        }
        return json({ ok: true, net });
      }

// ── GET /api/daily-tasks ──
      if (url.pathname === "/api/daily-tasks" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (!user) return json({ error: "user_not_found" }, 404);

        const todayStart = getTodayUTCStart();
const [doneData, depositData] = await env.DB.batch([
  env.DB.prepare("SELECT task_id, done_at FROM daily_tasks_done WHERE user_id=?").bind(tgUser.id),
  env.DB.prepare("SELECT 1 AS found FROM deposits WHERE user_id=? AND amount>=0.1 AND status='confirmed' AND created_at>=? LIMIT 1").bind(tgUser.id, todayStart),
]);

const doneRows = doneData.results;
const depositOkToday = depositData.results.length > 0;

const doneMap = {};
for (const r of doneRows) doneMap[r.task_id] = r.done_at;

const DAILY_TASKS = [
  { id: 1, title: "Just check in",            icon: "✅", reward: 0.001, type: "checkin", url: null },
  { id: 2, title: "Share with friends",       icon: "👥", reward: 0.001, type: "share",   url: null },
  { id: 3, title: "Check For Updates",        icon: "📢", reward: 0.001, type: "link",    url: "https://t.me/VaultMinerNews" },
  { id: 4, title: "Deposit 0.1+ TON Today",  icon: "💎", reward: 0.01,  type: "deposit", url: null },
];

return json({
  tasks: DAILY_TASKS.map(t => ({
    ...t,
    done: (doneMap[t.id] || 0) >= todayStart,
    deposit_ok: t.type === "deposit" ? depositOkToday : null,
  }))
});
      }

      // ── POST /api/daily-tasks/complete ──
      if (url.pathname === "/api/daily-tasks/complete" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "daily_task", 2000)) return json({ error: "rate_limited" }, 429);
        const { task_id } = await request.json();
        const tid = Number(task_id);
        if (![1, 2, 3, 4].includes(tid)) return json({ error: "invalid_task" }, 400);

        const todayStart = getTodayUTCStart();
        const reward = tid === 4 ? 0.01 : 0.001;

        if (tid === 4) {
          const todayDep = await env.DB.prepare(
            "SELECT 1 FROM deposits WHERE user_id=? AND amount>=0.1 AND status='confirmed' AND created_at>=?"
          ).bind(tgUser.id, todayStart).first();
          if (!todayDep) return json({ error: "deposit_required" }, 400);
        }

        // عملية ذرّية: تنجح فقط إذا لم تُسجَّل المهمة اليوم بالفعل
        const claimResult = await env.DB.prepare(
          `INSERT INTO daily_tasks_done(user_id, task_id, done_at) VALUES(?,?,?)
           ON CONFLICT(user_id, task_id) DO UPDATE SET done_at=excluded.done_at
           WHERE daily_tasks_done.done_at < ?`
        ).bind(tgUser.id, tid, Date.now(), todayStart).run();

        if (claimResult.meta.changes === 0) {
          return json({ error: "already_done_today" }, 400);
        }

        await env.DB.prepare(
          "UPDATE users SET balance=balance+? WHERE id=?"
        ).bind(reward, tgUser.id).run();

        const user = await env.DB.prepare("SELECT balance FROM users WHERE id=?").bind(tgUser.id).first();
        return json({ ok: true, reward, balance: user.balance });
      }

      // ── GET /api/partner-tasks ──
      if (url.pathname === "/api/partner-tasks" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);

        const { results: tasks } = await env.DB.prepare(
  "SELECT * FROM partner_tasks WHERE status='active' ORDER BY created_at DESC LIMIT 50"
).all();

        const { results: doneRows } = await env.DB.prepare(
          "SELECT task_id FROM partner_tasks_done WHERE user_id=?"
        ).bind(tgUser.id).all();

        const doneSet = new Set(doneRows.map(r => r.task_id));

        return json({
          tasks: tasks.map(t => ({
            ...t,
            done: doneSet.has(t.id),
            remaining: t.clicks_target - t.clicks_done,
          }))
        });
      }

      // ── POST /api/partner-tasks/complete ──
      if (url.pathname === "/api/partner-tasks/complete" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "partner_task", 2000)) return json({ error: "rate_limited" }, 429);
        const { task_id } = await request.json();
        const tid = Number(task_id);

        const task = await env.DB.prepare(
          "SELECT * FROM partner_tasks WHERE id=? AND status='active'"
        ).bind(tid).first();

        if (!task) return json({ error: "task_not_found" }, 404);
        if (task.clicks_done >= task.clicks_target) return json({ error: "task_full" }, 400);
        if (task.owner_id === tgUser.id) return json({ error: "own_task" }, 400);

        const existing = await env.DB.prepare(
          "SELECT 1 FROM partner_tasks_done WHERE user_id=? AND task_id=?"
        ).bind(tgUser.id, tid).first();
        if (existing) return json({ error: "already_done" }, 400);

        const newClicks = task.clicks_done + 1;
        const newStatus = newClicks >= task.clicks_target ? "completed" : "active";

        try {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO partner_tasks_done(user_id, task_id, done_at) VALUES(?,?,?)"
            ).bind(tgUser.id, tid, Date.now()),
            env.DB.prepare(
              "UPDATE partner_tasks SET clicks_done=?, status=? WHERE id=?"
            ).bind(newClicks, newStatus, tid),
            env.DB.prepare(
              "UPDATE users SET balance=balance+0.001 WHERE id=?"
            ).bind(tgUser.id),
          ]);
        } catch (e) {
          if (String(e).includes("UNIQUE") || String(e).includes("PRIMARY KEY")) {
            return json({ error: "already_done" }, 400);
          }
          throw e;
        }

        return json({ ok: true, reward: 0.001 });
      }

      // ── POST /api/partner-tasks/add ──
      if (url.pathname === "/api/partner-tasks/add" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        if (isRateLimited(tgUser.id, "add_task", 3000)) return json({ error: "rate_limited" }, 429);
        const { title, url: taskUrl, clicks } = await request.json();
        
        if (!title || !taskUrl || !clicks) return json({ error: "invalid_input" }, 400);
        try { new URL(taskUrl); } catch { return json({ error: "invalid_url" }, 400); }

        const clk = Number(clicks);
        if (clk < 250) return json({ error: "min_clicks_250" }, 400);

      const cost = clk / 500;

        const deductResult = await env.DB.prepare(
          "UPDATE users SET balance=balance-? WHERE id=? AND balance>=?"
        ).bind(cost, tgUser.id, cost).run();

        if (deductResult.meta.changes === 0)
          return json({ error: "insufficient_balance" }, 400);

        await env.DB.prepare(
          "INSERT INTO partner_tasks(owner_id, title, url, clicks_target, cost, created_at) VALUES(?,?,?,?,?,?)"
        ).bind(tgUser.id, title.slice(0, 80), taskUrl.slice(0, 200), clk, cost, Date.now()).run();

        return json({ ok: true, cost });
      }

      // ── POST /api/promo/apply ──
      if (url.pathname === "/api/promo/apply" && request.method === "POST") {
  const tgUser = await auth(request, env);
  if (!tgUser) return json({ error: "unauthorized" }, 401);
  if (isRateLimited(tgUser.id, "promo", 3000)) return json({ error: "rate_limited" }, 429);
  const { code } = await request.json();
  if (!code || !code.trim()) return json({ error: "invalid_code" }, 400);

  const promo = await env.DB.prepare(
    "SELECT * FROM promo_codes WHERE code=? AND active=1"
  ).bind(code.trim().toUpperCase()).first();
  if (!promo) return json({ error: "invalid_code" }, 400);

  const alreadyUsed = await env.DB.prepare(
    "SELECT 1 FROM promo_uses WHERE user_id=? AND code_id=?"
  ).bind(tgUser.id, promo.id).first();
  if (alreadyUsed) return json({ error: "already_used" }, 400);

  // ← atomic: يزيد فقط إذا used_count < max_uses
  const upd = await env.DB.prepare(
    "UPDATE promo_codes SET used_count=used_count+1 WHERE id=? AND used_count < max_uses AND active=1"
  ).bind(promo.id).run();

  if (upd.meta.changes === 0) return json({ error: "code_exhausted" }, 400);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO promo_uses(user_id, code_id, used_at) VALUES(?,?,?)"
    ).bind(tgUser.id, promo.id, Date.now()),
    env.DB.prepare(
      "UPDATE users SET balance=balance+? WHERE id=?"
    ).bind(promo.reward, tgUser.id),
  ]);

  return json({ ok: true, reward: promo.reward });
}
      
      // webhook
      if (url.pathname === "/api/webhook" && request.method === "POST") {
        const update  = await request.json().catch(() => ({}));
        const adminId = Number(env.ADMIN_ID || 0);
        const msg     = update.message;

        // ── /start ──
        if (msg && msg.text?.startsWith("/start")) {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              text: "⛏️ Welcome to Vault Miner!",
              reply_markup: {
                inline_keyboard: [[{
                  text: "🚀 Open Vault Miner",
                  web_app: { url: `https://vaultminerbot.thekingwarrior9.workers.dev` }
                }]]
              }
            })
          });
          return json({ ok: true });
        }

        // ── callback_query (Approve / Reject) ──
        if (update.callback_query) {
          const cbq = update.callback_query;

          if (cbq.from.id !== adminId) {
            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cbq.id, text: "⛔ Not authorized" }),
            });
            return json({ ok: true });
          }

          const cbData = cbq.data || "";

          // ── Approve ──
          if (cbData.startsWith("approve_")) {
            const withdrawalId = Number(cbData.replace("approve_", ""));
            const withdrawal   = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=?").bind(withdrawalId).first();

            if (!withdrawal || withdrawal.status !== "pending") {
              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: cbq.id, text: "⚠️ Already processed" }),
              });
              return json({ ok: true });
            }

            await env.DB.batch([
  env.DB.prepare("UPDATE withdrawals SET status='approved' WHERE id=?").bind(withdrawalId),
  env.DB.prepare("UPDATE users SET total_withdrawn=COALESCE(total_withdrawn,0)+? WHERE id=?").bind(withdrawal.net, withdrawal.user_id),
]);

            const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(withdrawal.user_id).first();
            let displayName;
            if (user?.username)        displayName = `@${user.username}`;
            else if (user?.first_name) displayName = user.first_name;
            else                       displayName = `ID: ${withdrawal.user_id}`;

            if (withdrawal.message_id && withdrawal.chat_id) {
              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id:    withdrawal.chat_id,
                  message_id: withdrawal.message_id,
                  text:
                    `✅ <b>Withdrawal Approved</b>\n\n` +
                    `👤 ${displayName}\n` +
                    `🆔 <code>${withdrawal.user_id}</code>\n` +
                    `💰 Amount: <b>${withdrawal.amount} TON</b>\n` +
                    `📊 Fee: <b>${Number(withdrawal.fee).toFixed(4)} TON</b>\n` +
                    `💵 Net sent: <b>${Number(withdrawal.net).toFixed(4)} TON</b>\n` +
                    `📍 Address: <code>${withdrawal.address}</code>\n` +
                    `📝 Memo: ${withdrawal.memo || "Vault Miner"}\n` +
                    `✅ Status: Approved\n\n` +
                    `👉 @VaultMiningBot ~ Earn 10% Daily Ton`,
                  parse_mode: "HTML",
                  disable_web_page_preview: true,
                }),
              });
            }

            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id:    withdrawal.user_id,
                text:
                  `✅ <b>Withdrawal Approved!</b>\n\n` +
                  `💵 Amount received: <b>${Number(withdrawal.net).toFixed(4)} TON</b>\n` +
                  `📍 Sent to: <code>${withdrawal.address}</code>`,
                parse_mode: "HTML",
              }),
            });

            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cbq.id, text: "✅ Approved" }),
            });
          }

          // ── Reject → ask admin for reason ──
          if (cbData.startsWith("reject_")) {
            const withdrawalId = Number(cbData.replace("reject_", ""));
            const withdrawal   = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=?").bind(withdrawalId).first();

            if (!withdrawal || withdrawal.status !== "pending") {
              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: cbq.id, text: "⚠️ Already processed" }),
              });
              return json({ ok: true });
            }

            const promptRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id:      adminId,
                text:         `✏️ Write the rejection reason for withdrawal #${withdrawalId}:`,
                reply_markup: { force_reply: true, selective: true },
              }),
            });
            const promptData = await promptRes.json();

            if (promptData.ok) {
              await env.DB.prepare(
                "INSERT INTO pending_rejections(withdrawal_id, prompt_message_id, created_at) VALUES(?,?,?)"
              ).bind(withdrawalId, promptData.result.message_id, Date.now()).run();
            }

            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback_query_id: cbq.id, text: "✏️ Send the reason in private chat" }),
            });
          }

          return json({ ok: true });
        }

        // ── Admin reply → rejection reason ──
        if (
          msg &&
          msg.reply_to_message &&
          msg.from?.id === adminId &&
          msg.chat?.type === "private"
        ) {
          const replyToMsgId = msg.reply_to_message.message_id;
          const pending = await env.DB.prepare(
            "SELECT * FROM pending_rejections WHERE prompt_message_id=?"
          ).bind(replyToMsgId).first();

          if (pending) {
            const withdrawalId = pending.withdrawal_id;
            const reason       = msg.text || "No reason provided";
            const withdrawal   = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=?").bind(withdrawalId).first();

            if (withdrawal && withdrawal.status === "pending") {
              await env.DB.batch([
                env.DB.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").bind(withdrawalId),
                env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(withdrawal.amount, withdrawal.user_id),
                env.DB.prepare("DELETE FROM pending_rejections WHERE id=?").bind(pending.id),
              ]);

              const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(withdrawal.user_id).first();
              let displayName;
              if (user?.username)        displayName = `@${user.username}`;
              else if (user?.first_name) displayName = user.first_name;
              else                       displayName = `ID: ${withdrawal.user_id}`;

              if (withdrawal.message_id && withdrawal.chat_id) {
                await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id:    withdrawal.chat_id,
                    message_id: withdrawal.message_id,
                    text:
                      `❌ <b>Withdrawal Rejected</b>\n\n` +
                      `👤 ${displayName}\n` +
                      `🆔 <code>${withdrawal.user_id}</code>\n` +
                      `💰 Amount: <b>${withdrawal.amount} TON</b>\n` +
                      `📊 Fee: <b>${Number(withdrawal.fee).toFixed(4)} TON</b>\n` +
                      `💵 Net: <b>${Number(withdrawal.net).toFixed(4)} TON</b>\n` +
                      `📍 Address: <code>${withdrawal.address}</code>\n` +
                      `📝 Memo: ${withdrawal.memo || "Vault Miner"}\n` +
                      `❌ Reason: ${reason}\n\n` +
                      `👉 @VaultMiningBot ~ Earn 10% Daily Ton`,
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                  }),
                });
              }

              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id:    withdrawal.user_id,
                  text:
                    `❌ <b>Withdrawal Rejected</b>\n\n` +
                    `💰 Amount: <b>${withdrawal.amount} TON</b>\n\n` +
                    `💡 Your balance has been refunded.`,
                  parse_mode: "HTML",
                }),
              });

              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: adminId,
                  text:    `✅ Rejection processed for withdrawal #${withdrawalId}`,
                }),
              });
            }
          }
        }

        return json({ ok: true });
      }

// ── friends/claim: سحب مكافآت الإحالة (الحد الأدنى 1 TON) ──
      if (url.pathname === "/api/friends/claim" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (!user) return json({ error: "user_not_found" }, 404);
        const rewards = user.referral_rewards || 0;
if (rewards < 1) return json({ error: "min_1_ton" }, 400);
const claimResult = await env.DB.prepare(
  "UPDATE users SET balance=balance+?, referral_rewards=0 WHERE id=? AND referral_rewards>=1"
).bind(rewards, tgUser.id).run();

if (claimResult.meta.changes === 0) 
  return json({ error: "min_1_ton" }, 400);
        return json({ ok: true, claimed: rewards, balance: user.balance + rewards });
      }

      // ── friends/milestones GET: الـ milestones المطالَب بها ──
      if (url.pathname === "/api/friends/milestones" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT milestone FROM milestone_claims WHERE user_id=?"
        ).bind(tgUser.id).all();
        return json({ claimed: results.map(r => r.milestone) });
      }

      // ── friends/milestone POST: المطالبة بمكافأة milestone ──
      if (url.pathname === "/api/friends/milestone" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { milestone } = await request.json();
        const MILESTONES = { 10: 0.005, 100: 0.025, 500: 0.1, 1000: 0.2, 5000: 1 };
        const reward = MILESTONES[Number(milestone)];
        if (!reward) return json({ error: "invalid_milestone" }, 400);
        const user = await env.DB.prepare("SELECT friends_count FROM users WHERE id=?").bind(tgUser.id).first();
        if (!user) return json({ error: "user_not_found" }, 404);
        if ((user.friends_count || 0) < Number(milestone)) return json({ error: "not_enough_friends" }, 400);
        try {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO milestone_claims(user_id, milestone, claimed_at) VALUES(?,?,?)"
    ).bind(tgUser.id, Number(milestone), Date.now()),
    env.DB.prepare(
      "UPDATE users SET balance=balance+? WHERE id=?"
    ).bind(reward, tgUser.id),
  ]);
} catch (e) {
  if (String(e).includes("UNIQUE") || String(e).includes("PRIMARY KEY")) {
    return json({ error: "already_claimed" }, 400);
  }
  throw e;
}
        return json({ ok: true, reward });
      }

// ── GET /api/leaderboard ──
if (url.pathname === "/api/leaderboard" && request.method === "GET") {
  const tgUser = await auth(request, env);
  if (!tgUser) return json({ error: "unauthorized" }, 401);

  // Worker Cache للقوائم فقط — 5 دقائق مشتركة بين كل المستخدمين
  const cache    = caches.default;
  const cacheKey = new Request("https://cache.vault/leaderboard-lists");
  let refTop, depTop;

  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) {
    const cached = await cachedRes.json();
    refTop = cached.referrals;
    depTop = cached.deposits;
  } else {
    const [refData, depData] = await env.DB.batch([
      env.DB.prepare("SELECT id, username, first_name, photo_url, friends_count FROM users ORDER BY friends_count DESC LIMIT 20"),
      env.DB.prepare("SELECT id, username, first_name, photo_url, deposit_amount FROM users ORDER BY deposit_amount DESC LIMIT 20"),
    ]);
    refTop = refData.results;
    depTop = depData.results;
    await cache.put(cacheKey, new Response(
      JSON.stringify({ referrals: refTop, deposits: depTop }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=28800" } }
    ));
  }

  // My Rank — كاش لكل مستخدم، متزامن مع نفس نافذة 8h لقوائم leaderboard
  const RANK_PERIOD_MS = 8 * 60 * 60 * 1000;
  const period  = Math.floor(Date.now() / RANK_PERIOD_MS);
  const rankKey = new Request(`https://cache.vault/myrank-${tgUser.id}-${period}`);

  let myRankReferrals, myRankDeposits;
  const cachedRank = await cache.match(rankKey);

  if (cachedRank) {
    const cr = await cachedRank.json();
    myRankReferrals = cr.referrals;
    myRankDeposits  = cr.deposits;
  } else {
    const [myRefResult, myDepResult] = await env.DB.batch([
      env.DB.prepare(
        "SELECT COUNT(*)+1 AS rank FROM users WHERE friends_count > COALESCE((SELECT friends_count FROM users WHERE id=?),-1)"
      ).bind(tgUser.id),
      env.DB.prepare(
        "SELECT COUNT(*)+1 AS rank FROM users WHERE deposit_amount > COALESCE((SELECT deposit_amount FROM users WHERE id=?),-1)"
      ).bind(tgUser.id),
    ]);
    myRankReferrals = myRefResult.results[0]?.rank ?? 999;
    myRankDeposits  = myDepResult.results[0]?.rank ?? 999;

    const periodEnd = (period + 1) * RANK_PERIOD_MS;
    const maxAge     = Math.max(60, Math.floor((periodEnd - Date.now()) / 1000));
    await cache.put(rankKey, new Response(
      JSON.stringify({ referrals: myRankReferrals, deposits: myRankDeposits }),
      { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${maxAge}` } }
    ));
  }

  const PERIOD_MS  = 480 * 60 * 60 * 1000;
  const LB_EPOCH   = 1781049600000;
  const now        = Date.now();
  const elapsed    = Math.max(0, now - LB_EPOCH);
  const nextReward = LB_EPOCH + (Math.floor(elapsed / PERIOD_MS) + 1) * PERIOD_MS;

  return json({
    referrals:         refTop.map((u, i) => ({ ...u, rank: i + 1 })),
    deposits:          depTop.map((u, i) => ({ ...u, rank: i + 1 })),
    my_rank_referrals: myRankReferrals,
    my_rank_deposits:  myRankDeposits,
    next_reward:       nextReward,
  });
}

// ── GET /api/top-miners ──
if (url.pathname === "/api/top-miners" && request.method === "GET") {
  const tgUser = await auth(request, env);
  if (!tgUser) return json({ error: "unauthorized" }, 401);

  const today    = new Date().toISOString().slice(0, 10);
  const cache    = caches.default;
  const cacheKey = new Request(`https://cache.vault/top-miners-${today}`);

  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) {
    const cached = await cachedRes.json();
    return json(cached);
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT id, username, first_name, photo_url, deposit_amount FROM users WHERE last_collect_at >= ? ORDER BY deposit_amount DESC LIMIT 5"
  ).bind(cutoff).all();

  const miners = results.map(u => ({
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    photo_url: u.photo_url,
    profit24: (u.deposit_amount || 0) * 0.10,
  }));

  const data = { miners };

  const now2 = new Date();
  const nextMidnight = Date.UTC(now2.getUTCFullYear(), now2.getUTCMonth(), now2.getUTCDate() + 1, 0, 0, 0, 0);
  const maxAge = Math.max(60, Math.floor((nextMidnight - Date.now()) / 1000));

  await cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${maxAge}` }
  }));

  return json(data);
}
      
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};

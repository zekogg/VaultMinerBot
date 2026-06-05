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
  const lastError = await this.state.storage.get("lastError") ?? null;
  return Response.json({ status, amount, lastError });
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
      `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(depositAddress)}&limit=100&archival=false`,
      { headers }
    );

    if (!tonRes.ok) {
      await this.state.storage.put("lastError", `TonCenter HTTP ${tonRes.status}`);
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
              await this.state.storage.put("lastError", `comment_decode_error: ${String(e?.message || e)}`);
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

        try {
          await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE users SET deposit_amount=deposit_amount+? WHERE id=?"
            ).bind(amount, userId),
            this.env.DB.prepare(
              "INSERT INTO deposits(user_id,tx_hash,amount,status,created_at) VALUES(?,?,?,'confirmed',?)"
            ).bind(userId, txHash, amount, Date.now()),
          ]);
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

        await this.state.storage.put("status", "found");
        await this.state.storage.put("amount", amount);
        await this.notifyUser(userId, amount);
        return;
      }
    } else {
      await this.state.storage.put("lastError", "toncenter_invalid_response");
    }
  } catch (e) {
    await this.state.storage.put("lastError", String(e?.message || e || "unknown_error"));
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

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance REAL NOT NULL DEFAULT 0,
      mined REAL NOT NULL DEFAULT 0,
      last_claim INTEGER NOT NULL DEFAULT 0,
      deposit_amount REAL NOT NULL DEFAULT 0,
      referrer_id INTEGER,
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS task_done (
      user_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      done_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, task_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      fee REAL NOT NULL,
      net REAL NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`),
  ]);

  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN deposit_amount REAL NOT NULL DEFAULT 0").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE deposits ADD COLUMN tx_hash TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE deposits ADD COLUMN amount REAL DEFAULT 0").run(); } catch {}
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits(tx_hash)").run(); } catch {}

  const { results } = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks").all();
  if (results[0].c === 0) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tasks(title,url,reward,active) VALUES (?,?,?,1)").bind("Join our Telegram channel", "https://t.me/", 0.5),
      env.DB.prepare("INSERT INTO tasks(title,url,reward,active) VALUES (?,?,?,1)").bind("Follow on X (Twitter)", "https://twitter.com/", 0.5),
      env.DB.prepare("INSERT INTO tasks(title,url,reward,active) VALUES (?,?,?,1)").bind("Subscribe on YouTube", "https://youtube.com/", 0.5),
    ]);
  }
}

async function getOrCreateUser(env, tgUser, referrerId) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
  if (row) return row;
  let ref = null;
  if (referrerId && Number(referrerId) !== tgUser.id) ref = Number(referrerId);
  await env.DB.prepare(
    "INSERT INTO users(id,username,first_name,balance,mined,last_claim,deposit_amount,referrer_id,created_at) VALUES(?,?,?,0,0,?,0,?,?)"
  ).bind(tgUser.id, tgUser.username || null, tgUser.first_name || null, now, ref, now).run();
  if (ref) {
    await env.DB.prepare("UPDATE users SET balance=balance+1 WHERE id=?").bind(ref).run();
  }
  return await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
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
      await ensureSchema(env);
      const FEE = Number(env.NETWORK_FEE || 1);

      if (url.pathname === "/api/init") return json({ ok: true });

      // me
      if (url.pathname === "/api/me" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await getOrCreateUser(env, tgUser, body.ref);
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
          },
          config: { fee: FEE, bot_username: env.BOT_USERNAME || "" },
        });
      }

      // claim
      if (url.pathname === "/api/claim" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        const mined = computeMined(user);
        if (mined < 0.1) return json({ error: "min_collect_0.1" }, 400);
        const now = Date.now();
        await env.DB.prepare("UPDATE users SET balance=balance+?, last_claim=? WHERE id=?")
          .bind(mined, now, user.id).run();
        return json({ ok: true, claimed: mined, balance: user.balance + mined });
      }

      // tasks list
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results: tasks } = await env.DB.prepare("SELECT * FROM tasks WHERE active=1").all();
        const { results: done } = await env.DB.prepare("SELECT task_id FROM task_done WHERE user_id=?").bind(tgUser.id).all();
        const doneSet = new Set(done.map(d => d.task_id));
        return json({ tasks: tasks.map(t => ({ ...t, done: doneSet.has(t.id) })) });
      }

      // complete task
      if (url.pathname === "/api/tasks/complete" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { task_id } = await request.json();
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=? AND active=1").bind(task_id).first();
        if (!task) return json({ error: "task_not_found" }, 404);
        const exists = await env.DB.prepare("SELECT 1 FROM task_done WHERE user_id=? AND task_id=?").bind(tgUser.id, task_id).first();
        if (exists) return json({ error: "already_done" }, 400);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO task_done(user_id,task_id,done_at) VALUES(?,?,?)").bind(tgUser.id, task_id, Date.now()),
          env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(task.reward, tgUser.id),
        ]);
        return json({ ok: true, reward: task.reward });
      }

      // friends
      if (url.pathname === "/api/friends" && request.method === "GET") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, username, first_name, created_at FROM users WHERE referrer_id=? ORDER BY created_at DESC LIMIT 100"
        ).bind(tgUser.id).all();
        return json({ friends: results, link: `https://t.me/${env.BOT_USERNAME || "your_bot"}?start=${tgUser.id}` });
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

      // reinvest
      if (url.pathname === "/api/reinvest" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { amount } = await request.json();
        const amt = Number(amount);
        if (!amt || amt < 0.1) return json({ error: "min_reinvest_0.1" }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (!user) return json({ error: "user_not_found" }, 404);
        if (user.balance < amt) return json({ error: "insufficient_balance" }, 400);
        await env.DB.prepare(
          "UPDATE users SET balance=balance-?, deposit_amount=deposit_amount+? WHERE id=?"
        ).bind(amt, amt, tgUser.id).run();
        const updated = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        return json({ ok: true, deposit_amount: updated.deposit_amount, balance: updated.balance });
      }

      // withdraw
      if (url.pathname === "/api/withdraw" && request.method === "POST") {
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { amount, address } = await request.json();
        const amt = Number(amount);
        if (!amt || amt <= 0 || !address) return json({ error: "invalid_input" }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (user.balance < amt) return json({ error: "insufficient_balance" }, 400);
        if (amt <= FEE) return json({ error: "amount_too_small" }, 400);
        const net = amt - FEE;
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET balance=balance-? WHERE id=?").bind(amt, tgUser.id),
          env.DB.prepare("INSERT INTO withdrawals(user_id,amount,fee,net,address,status,created_at) VALUES(?,?,?,?,?,'pending',?)").bind(tgUser.id, amt, FEE, net, address, Date.now()),
        ]);
        await notifyChannel(env,
          `🔴 <b>Withdrawal Request</b>\n` +
          `User: <code>${tgUser.id}</code> (@${tgUser.username || "-"})\n` +
          `Name: ${tgUser.first_name || "-"}\n` +
          `Amount: <b>${amt}</b>\n` +
          `Fee: ${FEE}\n` +
          `Net to send: <b>${net}</b>\n` +
          `Address: <code>${address}</code>`
        );
        return json({ ok: true, net });
      }

      // webhook
      if (url.pathname === "/api/webhook" && request.method === "POST") {
        const update = await request.json().catch(() => ({}));
        const msg = update.message;
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
        }
        return json({ ok: true });
      }

// debug endpoint (admin only)
if (url.pathname === "/api/debug/do-status" && request.method === "GET") {
  const tgUser = await auth(request, env);
  if (!tgUser || tgUser.id !== 1018495986) return json({ error: "unauthorized" }, 401);
  const doId = env.DEPOSIT_CHECKER.idFromName(`user_${tgUser.id}`);
  const doStub = env.DEPOSIT_CHECKER.get(doId);
  const res = await doStub.fetch("http://do/status");
  const data = await res.json();
  return json(data);
}
      
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};

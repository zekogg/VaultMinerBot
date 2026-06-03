
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

// ---------- Telegram initData verification (HMAC-SHA256) ----------
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

// ---------- DB helpers ----------
async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance REAL NOT NULL DEFAULT 0,
      mined REAL NOT NULL DEFAULT 0,
      last_claim INTEGER NOT NULL DEFAULT 0,
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
      memo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
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
  // seed default tasks
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
    "INSERT INTO users(id,username,first_name,balance,mined,last_claim,referrer_id,created_at) VALUES(?,?,?,0,0,?,?,?)"
  ).bind(tgUser.id, tgUser.username || null, tgUser.first_name || null, now, ref, now).run();
  // referral bonus
  if (ref) {
    await env.DB.prepare("UPDATE users SET balance=balance+1 WHERE id=?").bind(ref).run();
  }
  return await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
}

function computeMined(user, dailyRate) {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - (user.last_claim || now));
  const perMs = dailyRate / (24 * 60 * 60 * 1000);
  return elapsedMs * perMs;
}

// ---------- Telegram notify ----------
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
  } catch (e) { /* ignore */ }
}

// ---------- Auth wrapper ----------
async function auth(request, env) {
  const initData = request.headers.get("X-Init-Data") || "";
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user) return null;
  return user;
}

// ---------- Routes ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      await ensureSchema(env);
      const DAILY = Number(env.DAILY_RATE || 0.5);
      const FEE = Number(env.NETWORK_FEE || 1);

      // Init endpoint (open to allow first-time table creation)
      if (url.pathname === "/api/init") return json({ ok: true });

      // me - login / current state
      if (url.pathname === "/api/me" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const tgUser = await auth(request, env);
        if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await getOrCreateUser(env, tgUser, body.ref);
        const mined = computeMined(user, DAILY);
        return json({
          user: {
            id: user.id, username: user.username, first_name: user.first_name,
            balance: user.balance, mined, last_claim: user.last_claim,
          },
          config: { daily_rate: DAILY, fee: FEE, bot_username: env.BOT_USERNAME || "" },
        });
      }

      // claim mined
      if (url.pathname === "/api/claim" && request.method === "POST") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        const mined = computeMined(user, DAILY);
        const now = Date.now();
        await env.DB.prepare("UPDATE users SET balance=balance+?, last_claim=? WHERE id=?")
          .bind(mined, now, user.id).run();
        return json({ ok: true, claimed: mined, balance: user.balance + mined });
      }

      // tasks list
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results: tasks } = await env.DB.prepare("SELECT * FROM tasks WHERE active=1").all();
        const { results: done } = await env.DB.prepare("SELECT task_id FROM task_done WHERE user_id=?").bind(tgUser.id).all();
        const doneSet = new Set(done.map(d => d.task_id));
        return json({ tasks: tasks.map(t => ({ ...t, done: doneSet.has(t.id) })) });
      }

      // complete task
      if (url.pathname === "/api/tasks/complete" && request.method === "POST") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
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

      // friends / referrals
      if (url.pathname === "/api/friends" && request.method === "GET") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, username, first_name, created_at FROM users WHERE referrer_id=? ORDER BY created_at DESC LIMIT 100"
        ).bind(tgUser.id).all();
        return json({ friends: results, link: `https://t.me/${env.BOT_USERNAME || "your_bot"}?start=${tgUser.id}` });
      }

      // deposit info (wallet address + memo for this user)
      if (url.pathname === "/api/deposit" && request.method === "GET") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const memo = `LM${tgUser.id}`;
        return json({ address: env.DEPOSIT_ADDRESS || "", memo });
      }

      // deposit check (notifies admin channel to verify manually)
      if (url.pathname === "/api/deposit/check" && request.method === "POST") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const memo = `LM${tgUser.id}`;
        await env.DB.prepare("INSERT INTO deposits(user_id,memo,status,created_at) VALUES(?,?, 'pending',?)")
          .bind(tgUser.id, memo, Date.now()).run();
        await notifyChannel(env,
          `🟡 <b>Deposit Check Request</b>\n` +
          `User: <code>${tgUser.id}</code> (@${tgUser.username || "-"})\n` +
          `Name: ${tgUser.first_name || "-"}\n` +
          `Memo: <code>${memo}</code>\n` +
          `Please verify the incoming transaction and credit the user manually.`
        );
        return json({ ok: true });
      }

      // withdraw request
      if (url.pathname === "/api/withdraw" && request.method === "POST") {
        const tgUser = await auth(request, env); if (!tgUser) return json({ error: "unauthorized" }, 401);
        const { amount, address } = await request.json();
        const amt = Number(amount);
        if (!amt || amt <= 0 || !address) return json({ error: "invalid_input" }, 400);
        const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(tgUser.id).first();
        if (user.balance < amt) return json({ error: "insufficient_balance" }, 400);
        if (amt <= FEE) return json({ error: "amount_too_small" }, 400);
        const net = amt - FEE;
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET balance=balance-? WHERE id=?").bind(amt, tgUser.id),
          env.DB.prepare("INSERT INTO withdrawals(user_id,amount,fee,net,address,status,created_at) VALUES(?,?,?,?,?, 'pending',?)")
            .bind(tgUser.id, amt, FEE, net, address, Date.now()),
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

// Telegram Webhook
if (url.pathname === "/api/webhook" && request.method === "POST") {
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (msg && msg.text === "/start") {
    const refParam = msg.text.split(" ")[1] || "";
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: "⛏️ Welcome to Lucky Miner!",
        reply_markup: {
          inline_keyboard: [[{
            text: "🚀 Open Lucky Miner",
            web_app: { url: `https://vaultminerbot.workers.dev` }
          }]]
        }
      })
    });
  }
  return json({ ok: true });
}
      
      if (url.pathname.startsWith("/api/")) {
  return json({ error: "not_found" }, 404);
}
return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};

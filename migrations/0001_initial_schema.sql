CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  username         TEXT,
  first_name       TEXT,
  balance          REAL    NOT NULL DEFAULT 0,
  mined            REAL    NOT NULL DEFAULT 0,
  last_claim       INTEGER NOT NULL DEFAULT 0,
  deposit_amount   REAL    NOT NULL DEFAULT 0,
  referrer_id      INTEGER,
  created_at       INTEGER NOT NULL,
  referral_rewards REAL    NOT NULL DEFAULT 0,
  photo_url        TEXT,
  friends_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  title  TEXT    NOT NULL,
  url    TEXT    NOT NULL,
  reward REAL    NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS task_done (
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS deposits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  tx_hash    TEXT    NOT NULL UNIQUE,
  amount     REAL    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL,
  memo       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash
  ON deposits(tx_hash);

CREATE TABLE IF NOT EXISTS withdrawals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  amount     REAL    NOT NULL,
  fee        REAL    NOT NULL,
  net        REAL    NOT NULL,
  address    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  memo       TEXT,
  message_id INTEGER,
  chat_id    TEXT
);

CREATE TABLE IF NOT EXISTS pending_rejections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  withdrawal_id     INTEGER NOT NULL,
  prompt_message_id INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS milestone_claims (
  user_id    INTEGER NOT NULL,
  milestone  INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, milestone)
);

CREATE TABLE IF NOT EXISTS daily_tasks_done (
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS partner_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  clicks_target INTEGER NOT NULL,
  clicks_done   INTEGER NOT NULL DEFAULT 0,
  cost          REAL    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_tasks_done (
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  reward     REAL    NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_uses (
  user_id INTEGER NOT NULL,
  code_id INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, code_id)
);

CREATE INDEX IF NOT EXISTS idx_users_friends_count
  ON users(friends_count DESC);

CREATE INDEX IF NOT EXISTS idx_users_deposit_amount
  ON users(deposit_amount DESC);

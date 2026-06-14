CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS staff_codes (email TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_staffcodes_email ON staff_codes(email);
CREATE TABLE IF NOT EXISTS staff_sessions (token TEXT PRIMARY KEY, staff_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_push_staff ON push_subs(staff_id);

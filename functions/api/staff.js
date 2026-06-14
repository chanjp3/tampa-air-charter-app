// POST /api/staff  — staff-side API (separate session from clients)
//   {action:'send', email}            -> emails a code (email must be in STAFF_EMAILS)
//   {action:'verify', email, code}    -> staff session cookie
//   {action:'logout'}
//   {action:'config'}                 -> { vapidPublic }  (for push subscribe)
//   {action:'subscribe', sub}         -> store push subscription
//   {action:'inbox'}                  -> requests + quotes + client contact (staff view)
//   {action:'quote', request_id, amount, message, valid_until, booking_url}
//   {action:'status', request_id, status}
//   {action:'test_push'}              -> send yourself a test notification
import { json, bad, randomToken, sixDigit, getCookie, sendEmail,
         currentStaff, staffCookie, isAllowedStaff } from './_utils.js';
import { pushAllStaff, sendPush } from './_push.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  let b; try { b = await request.json(); } catch { return bad('bad json'); }
  const action = b.action || '';

  if (action === 'logout') {
    const t = getCookie(request, 'tac_staff');
    if (t) await env.DB.prepare('DELETE FROM staff_sessions WHERE token=?1').bind(t).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'tac_staff=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  if (action === 'send') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('valid email required');
    if (!isAllowedStaff(env, email)) return bad('this email is not on the staff list', 403);
    const code = sixDigit();
    await env.DB.prepare('DELETE FROM staff_codes WHERE email=?1').bind(email).run();
    await env.DB.prepare(`INSERT INTO staff_codes (email,code,expires_at) VALUES (?1,?2,datetime('now','+10 minutes'))`).bind(email, code).run();
    const mail = await sendEmail(env, email, 'Your TAC Desk sign-in code', `TAC Desk code: ${code}\nExpires in 10 minutes.`);
    const dev = env.DEV_MODE === '1' ? { dev_code: code } : {};
    if (!mail.sent && env.DEV_MODE !== '1') return bad('email not configured (set RESEND_API_KEY or DEV_MODE=1)', 503);
    return json({ ok: true, ...dev });
  }

  if (action === 'verify') {
    const email = String(b.email || '').trim().toLowerCase();
    const code = String(b.code || '').trim();
    if (!isAllowedStaff(env, email)) return bad('not on the staff list', 403);
    const row = await env.DB.prepare(`SELECT rowid,* FROM staff_codes WHERE email=?1 AND expires_at>datetime('now') ORDER BY created_at DESC LIMIT 1`).bind(email).first();
    if (!row) return bad('code expired — request a new one');
    if (row.attempts >= 6) return bad('too many attempts');
    if (row.code !== code) { await env.DB.prepare('UPDATE staff_codes SET attempts=attempts+1 WHERE rowid=?1').bind(row.rowid).run(); return bad('incorrect code'); }
    await env.DB.prepare('DELETE FROM staff_codes WHERE email=?1').bind(email).run();
    let st = await env.DB.prepare('SELECT * FROM staff WHERE email=?1').bind(email).first();
    if (!st) { const id = crypto.randomUUID(); await env.DB.prepare('INSERT INTO staff (id,email) VALUES (?1,?2)').bind(id, email).run(); st = { id, email, name: '' }; }
    const token = randomToken();
    await env.DB.prepare(`INSERT INTO staff_sessions (token,staff_id,expires_at) VALUES (?1,?2,datetime('now','+30 days'))`).bind(token, st.id).run();
    return json({ ok: true, staff: { email: st.email, name: st.name } }, 200, { 'Set-Cookie': staffCookie(token) });
  }

  // ---- everything below requires a staff session ----
  const me = await currentStaff(context);
  if (!me) return bad('not signed in', 401);

  if (action === 'config') return json({ ok: true, vapidPublic: env.VAPID_PUBLIC || '' });

  if (action === 'subscribe') {
    const s = b.sub || {};
    if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return bad('bad subscription');
    await env.DB.prepare(
      `INSERT INTO push_subs (staff_id,endpoint,p256dh,auth) VALUES (?1,?2,?3,?4)
       ON CONFLICT(endpoint) DO UPDATE SET staff_id=?1, p256dh=?3, auth=?4`
    ).bind(me.id, s.endpoint, s.keys.p256dh, s.keys.auth).run();
    return json({ ok: true });
  }

  if (action === 'test_push') {
    const subs = (await env.DB.prepare('SELECT * FROM push_subs WHERE staff_id=?1').bind(me.id).all()).results;
    let sent = 0;
    for (const sub of subs) { try { const c = await sendPush(env, sub, { title: 'TAC Desk', body: 'Notifications are working ✓', url: '/staff/' }); if (c === 201 || c === 200) sent++; } catch {} }
    return json({ ok: true, sent });
  }

  if (action === 'inbox') {
    const requests = (await env.DB.prepare(
      `SELECT r.*, c.email AS client_email, c.name AS client_name, c.phone AS client_phone
       FROM requests r JOIN clients c ON c.id=r.client_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'quoted' THEN 1 WHEN 'accepted' THEN 2 ELSE 3 END, r.created_at DESC LIMIT 100`
    ).all()).results;
    const ids = requests.map(r => r.id);
    let quotes = [];
    if (ids.length) {
      const ph = ids.map((_, i) => `?${i + 1}`).join(',');
      quotes = (await env.DB.prepare(`SELECT * FROM quotes WHERE request_id IN (${ph}) ORDER BY created_at ASC`).bind(...ids).all()).results;
    }
    const byReq = {}; for (const q of quotes) (byReq[q.request_id] = byReq[q.request_id] || []).push(q);
    return json({ ok: true, me: { email: me.email, name: me.name }, requests: requests.map(r => ({ ...r, quotes: byReq[r.id] || [] })) });
  }

  if (action === 'quote') {
    const req = await env.DB.prepare(
      'SELECT r.*, c.email AS client_email, c.name AS client_name FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?1'
    ).bind(String(b.request_id || '')).first();
    if (!req) return bad('no such request');
    const amount = String(b.amount || '').trim();
    if (!amount) return bad('amount required');
    const msg = String(b.message || '');
    const booking = String(b.booking_url || '').trim();
    // fold the booking link into the quote message so the client app shows it
    const fullMsg = booking ? `${msg}${msg ? '\n\n' : ''}Book & pay: ${booking}` : msg;
    await env.DB.prepare('INSERT INTO quotes (request_id,amount,message,valid_until) VALUES (?1,?2,?3,?4)')
      .bind(req.id, amount, fullMsg, String(b.valid_until || '')).run();
    await env.DB.prepare("UPDATE requests SET status='quoted' WHERE id=?1").bind(req.id).run();
    await sendEmail(env, req.client_email,
      `Your quote is ready — ${req.from_ap} → ${req.to_ap}`,
      `Hi ${req.client_name || ''},\n\nYour Tampa Air Charter quote:\n\n${req.from_ap} → ${req.to_ap}\n${amount}` +
      `${b.valid_until ? `\nValid until ${b.valid_until}` : ''}\n\n${fullMsg}\n\nOpen the TAC Members app to review and accept.\n\n— Tampa Air Charter`);
    return json({ ok: true });
  }

  if (action === 'status') {
    const allowed = ['pending', 'quoted', 'accepted', 'booked', 'closed'];
    if (!allowed.includes(b.status)) return bad('bad status');
    await env.DB.prepare('UPDATE requests SET status=?1 WHERE id=?2').bind(b.status, String(b.request_id || '')).run();
    return json({ ok: true });
  }

  return bad('unknown action');
}

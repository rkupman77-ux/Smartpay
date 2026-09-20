import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const port = process.env.PORT || 3000;
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false }});
const authClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false }});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WebP images are allowed'), ok);
  }
});

const amounts = () => (process.env.ORDER_AMOUNTS || '500,1000,1500,2000,2500,3000,5000')
  .split(',').map(x => Number(x.trim())).filter(x => Number.isFinite(x) && x > 0);

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
async function userFromReq(req) {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
async function profile(userId) {
  const { data, error } = await admin.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}
async function requireUser(req, res, next) {
  try {
    const user = await userFromReq(req);
    if (!user) return res.status(401).json({ error: 'Login required' });
    req.user = user;
    req.profile = await profile(user.id);
    if (!req.profile) return res.status(403).json({ error: 'Profile not found' });
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function requireAdmin(req, res, next) {
  if (req.profile?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  let found = null;
  let page = 1;
  while (!found && page <= 20) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    found = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (data.users.length < 1000) break;
    page++;
  }
  if (!found) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    found = data.user;
  } else {
    await admin.auth.admin.updateUserById(found.id, { password });
  }
  await admin.from('profiles').upsert({
    id: found.id, email, role: 'admin', balance: 0, password_hash: ''
  }, { onConflict: 'id' });
}

async function notify(subject, text) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'P2P Platform <onboarding@resend.dev>',
        to: [process.env.NOTIFY_EMAIL],
        subject, text
      })
    });
  } catch {}
}

app.get('/api/config', async (_req, res) => {
  const { data } = await admin.from('settings').select('key,value');
  const s = Object.fromEntries((data || []).map(x => [x.key, x.value]));
  res.json({
    siteName: s.site_name || process.env.SITE_NAME || 'P2P Platform',
    bankName: s.bank_name || '',
    accountHolder: s.account_holder || '',
    accountNumber: s.account_number || '',
    ifsc: s.ifsc || '',
    upiId: s.upi_id || '',
    supportUrl: s.support_url || process.env.SUPPORT_URL || 'https://t.me/',
    orderAmounts: (s.order_amounts || amounts().join(',')).split(',').map(Number).filter(Boolean)
  });
});

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Valid email and 8+ character password required' });
  const { data, error } = await authClient.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  if (data.user) {
    await admin.from('profiles').upsert({ id: data.user.id, email: data.user.email, role: 'user', balance: 0, password_hash: '' }, { onConflict: 'id' });
  }
  res.json({ session: data.session, message: 'Registration successful. Email confirmation may be required by your Supabase settings.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  await admin.from('profiles').upsert({ id: data.user.id, email: data.user.email, role: 'user', balance: 0, password_hash: '' }, { onConflict: 'id', ignoreDuplicates: true });
  res.json({ session: data.session });
});

app.get('/api/me', requireUser, async (req, res) => res.json({ user: req.user, profile: req.profile }));

app.get('/api/orders', requireUser, async (req, res) => {
  const { data, error } = await admin.from('orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data });
});

app.post('/api/orders', requireUser, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amounts().includes(amount)) return res.status(400).json({ error: 'Invalid order amount' });
  const { data, error } = await admin.from('orders').insert({ user_id: req.user.id, amount, status: 'AWAITING_PAYMENT' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ order: data });
});

app.post('/api/orders/:id/proof', requireUser, upload.single('screenshot'), async (req, res) => {
  const { id } = req.params;
  const { utr } = req.body || {};
  if (!utr || !req.file) return res.status(400).json({ error: 'UTR and screenshot are required' });

  const { data: order, error: oe } = await admin.from('orders').select('*').eq('id', id).eq('user_id', req.user.id).single();
  if (oe || !order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'AWAITING_PAYMENT') return res.status(400).json({ error: 'This order is not awaiting payment proof' });

  const path = `${req.user.id}/${id}-${crypto.randomUUID()}.${req.file.mimetype.split('/')[1]}`;
  const { error: se } = await admin.storage.from('payment-screenshots').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (se) return res.status(500).json({ error: se.message });

  const { data, error } = await admin.from('orders').update({
    utr: String(utr).slice(0, 120), screenshot_path: path, status: 'PENDING_REVIEW'
  }).eq('id', id).eq('user_id', req.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await notify('New payment proof submitted', `Order ${id} for ₹${order.amount} was submitted for review.`);
  res.json({ order: data });
});

app.get('/api/admin/orders', requireUser, requireAdmin, async (_req, res) => {
  const { data, error } = await admin.from('orders').select('*, profiles(email)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data });
});

app.get('/api/admin/screenshot/:orderId', requireUser, requireAdmin, async (req, res) => {
  const { data: order, error } = await admin.from('orders').select('screenshot_path').eq('id', req.params.orderId).single();
  if (error || !order?.screenshot_path) return res.status(404).send('Not found');
  const { data, error: se } = await admin.storage.from('payment-screenshots').createSignedUrl(order.screenshot_path, 300);
  if (se) return res.status(500).send(se.message);
  res.redirect(data.signedUrl);
});

app.post('/api/admin/orders/:id/review', requireUser, requireAdmin, async (req, res) => {
  const { decision } = req.body || {};
  if (!['APPROVED','REJECTED'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

  const { data: order, error: oe } = await admin.from('orders').select('*').eq('id', req.params.id).single();
  if (oe || !order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING_REVIEW') return res.status(400).json({ error: 'Order already reviewed' });

  const { data: updated, error } = await admin.from('orders').update({
    status: decision, reviewed_at: new Date().toISOString()
  }).eq('id', order.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (decision === 'APPROVED') {
    const { data: p } = await admin.from('profiles').select('balance').eq('id', order.user_id).single();
    const newBalance = Number(p?.balance || 0) + Number(order.amount);
    await admin.from('profiles').update({ balance: newBalance }).eq('id', order.user_id);
  }
  res.json({ order: updated });
});

app.post('/api/withdrawals', requireUser, async (req, res) => {
  const amount = Number(req.body.amount);
  const method = String(req.body.method || '').toUpperCase();
  const details = req.body.details || {};
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['BANK','UPI','PHONEPE','PAYTM'].includes(method)) return res.status(400).json({ error: 'Invalid withdrawal method' });

  const p = await profile(req.user.id);
  if (Number(p.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const { data: w, error } = await admin.from('withdrawals').insert({ user_id: req.user.id, amount, method, details, status: 'PENDING' }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  const { error: be } = await admin.from('profiles').update({ balance: Number(p.balance) - amount }).eq('id', req.user.id);
  if (be) return res.status(500).json({ error: be.message });

  await notify('New withdrawal request', `User ${req.user.email} requested ₹${amount} via ${method}.`);
  res.json({ withdrawal: w });
});

app.get('/api/withdrawals', requireUser, async (req, res) => {
  const { data, error } = await admin.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data });
});

app.get('/api/admin/withdrawals', requireUser, requireAdmin, async (_req, res) => {
  const { data, error } = await admin.from('withdrawals').select('*, profiles(email)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ withdrawals: data });
});

app.post('/api/admin/withdrawals/:id', requireUser, requireAdmin, async (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  if (!['PAID','REJECTED'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

  const { data: w, error: we } = await admin.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (we || !w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'PENDING') return res.status(400).json({ error: 'Already processed' });

  const { data: updated, error } = await admin.from('withdrawals').update({ status: decision, processed_at: new Date().toISOString() }).eq('id', w.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (decision === 'REJECTED') {
    const p = await profile(w.user_id);
    await admin.from('profiles').update({ balance: Number(p.balance || 0) + Number(w.amount) }).eq('id', w.user_id);
  }
  res.json({ withdrawal: updated });
});

app.post('/api/admin/settings', requireUser, requireAdmin, async (req, res) => {
  const allowed = ['site_name','bank_name','account_holder','account_number','ifsc','upi_id','support_url','order_amounts'];
  const entries = Object.entries(req.body || {}).filter(([k,v]) => allowed.includes(k) && typeof v === 'string');
  if (entries.length) {
    const { error } = await admin.from('settings').upsert(entries.map(([key,value]) => ({ key, value })), { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireUser, requireAdmin, async (_req, res) => {
  const { data, error } = await admin.from('settings').select('key,value');
  if (error) return res.status(500).json({ error: error.message });
  res.json(Object.fromEntries((data || []).map(x => [x.key, x.value])));
});

app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Request failed' });
});

ensureAdmin().then(() => {
  app.listen(port, () => console.log(`P2P Platform running on ${port}`));
}).catch(err => {
  console.error('Admin setup failed:', err);
  process.exit(1);
});

'use strict';

// Break Enforcer 第 7 步：小额授权 hold 的银行实测
//
// 这个工具回答两个问题：
//   实验 1: 压一笔 $1 授权，立刻 void，钱多快从银行账户回来
//   实验 2: 压一笔 $1.25，放满 120 小时再 void，惩罚撑不撑得住 5 天
//
// 顺带验证一件主应用强依赖的事：off-session 授权到底压不压得动。
// 主应用在 50:25 判罚的时候 Eric 人不在页面上，走的就是 off-session，
// 如果他的银行拒绝 off-session，整套机制会静默失效（Break_Enforcer_主应用.md「还没定的事」里的欠账模式）。
//
// 金额写死（实验 1 $1.00，实验 2 $1.25，金额不同是为了在银行 App 里分得清两笔），不从环境变量读，避免手滑压出一笔大钱。

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

// ---------- 固定参数 ----------
const AMOUNTS = { 1: 100, 2: 125 };     // 单位是分。实验 1 $1.00，实验 2 $1.25。写死。
const CURRENCY = 'cad';
const DESCRIPTOR_SUFFIX = 'HOLD TEST';  // 账单上会显示成 BREAK* HOLD TEST

// ---------- 环境 ----------
const PORT = Number(process.env.PORT || 4242);
const HOLD_HOURS = Number(process.env.HOLD_HOURS || 120);
const SECRET = (process.env.STRIPE_SECRET_KEY || '').trim();
const PUBLISHABLE = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();

function die(msg) {
  console.error('\n[配置错误] ' + msg + '\n');
  process.exit(1);
}

if (!SECRET) die('缺 STRIPE_SECRET_KEY。把 .env.example 复制成 .env 再填。key 自己去 Dashboard -> Developers -> API keys 取。');
if (!PUBLISHABLE) die('缺 STRIPE_PUBLISHABLE_KEY。');

const MODE = SECRET.startsWith('sk_live_') ? 'live'
  : SECRET.startsWith('sk_test_') ? 'test' : null;
if (!MODE) die('STRIPE_SECRET_KEY 不是 sk_live_ 或 sk_test_ 开头，检查有没有复制错。');

const PUB_MODE = PUBLISHABLE.startsWith('pk_live_') ? 'live'
  : PUBLISHABLE.startsWith('pk_test_') ? 'test' : null;
if (PUB_MODE !== MODE) {
  die('两个 key 模式对不上：secret 是 ' + MODE + '，publishable 是 ' + (PUB_MODE || '看不出来') + '。必须同模式。');
}

const stripe = Stripe(SECRET);

// ---------- 状态存盘 ----------
// live 和 test 分开存，test 模式的烟雾测试不会污染真实记录。
const RUNS_DIR = path.join(__dirname, 'runs');
const STATE_FILE = path.join(RUNS_DIR, 'state.' + MODE + '.json');

function emptyState() {
  return { mode: MODE, customer_id: null, payment_method: null, runs: [] };
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return emptyState();
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[警告] 状态文件读不动，当成空的：' + e.message);
    return emptyState();
  }
}
function saveState(s) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function now() { return new Date().toISOString(); }

// ---------- 服务 ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function wrap(fn) {
  return function (req, res) {
    Promise.resolve(fn(req, res)).catch(function (err) {
      console.error('[接口出错]', err);
      res.status(500).json({ error: err.message || String(err) });
    });
  };
}

app.get('/api/config', function (req, res) {
  res.json({
    mode: MODE,
    publishable_key: PUBLISHABLE,
    amounts: AMOUNTS,
    currency: CURRENCY,
    hold_hours: HOLD_HOURS,
  });
});

app.get('/api/state', wrap(async function (req, res) {
  res.json(loadState());
}));

// ---- 存卡：SetupIntent，$0，卡上零动静 ----
app.post('/api/setup-intent', wrap(async function (req, res) {
  const state = loadState();
  if (!state.customer_id) {
    const customer = await stripe.customers.create({
      description: 'Break Enforcer hold test',
      metadata: { project: 'break-enforcer', purpose: 'step-7-hold-test' },
    });
    state.customer_id = customer.id;
    saveState(state);
  }
  const si = await stripe.setupIntents.create({
    customer: state.customer_id,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { project: 'break-enforcer', purpose: 'step-7-hold-test' },
  });
  res.json({ client_secret: si.client_secret, customer_id: state.customer_id });
}));

app.post('/api/card-saved', wrap(async function (req, res) {
  const id = String(req.body.setup_intent_id || '');
  if (!id) return res.status(400).json({ error: '缺 setup_intent_id' });

  const si = await stripe.setupIntents.retrieve(id);
  if (si.status !== 'succeeded' || !si.payment_method) {
    return res.status(400).json({ error: '这张卡没存成功，SetupIntent 状态是 ' + si.status });
  }
  const pm = await stripe.paymentMethods.retrieve(String(si.payment_method));

  const state = loadState();
  state.payment_method = {
    id: pm.id,
    brand: pm.card ? pm.card.brand : null,
    last4: pm.card ? pm.card.last4 : null,
    funding: pm.card ? pm.card.funding : null,   // 应该是 debit，是 credit 就说明卡选错了
    country: pm.card ? pm.card.country : null,
    saved_at: now(),
  };
  saveState(state);
  res.json({ payment_method: state.payment_method });
}));

// ---- 压一笔 hold ----
async function createHold(experiment) {
  const state = loadState();
  const base = {
    amount: AMOUNTS[experiment],
    currency: CURRENCY,
    customer: state.customer_id,
    payment_method: state.payment_method.id,
    payment_method_types: ['card'],
    capture_method: 'manual',      // 只授权，永远不 capture
    confirm: true,
    off_session: true,             // 模拟主应用判罚时的真实场景
    description: 'Break Enforcer hold test #' + experiment,
    metadata: { project: 'break-enforcer', experiment: String(experiment) },
  };

  let pi;
  try {
    pi = await stripe.paymentIntents.create(
      Object.assign({ statement_descriptor_suffix: DESCRIPTOR_SUFFIX }, base)
    );
  } catch (err) {
    // 账号没设 statement descriptor 前缀时这个参数会被拒，去掉再来一次
    const isDescriptorProblem = err && err.param &&
      String(err.param).indexOf('statement_descriptor') !== -1;
    if (!isDescriptorProblem) throw err;
    console.warn('[提示] statement_descriptor_suffix 被拒，去掉该参数重试。原因：' + err.message);
    pi = await stripe.paymentIntents.create(base);
  }
  return pi;
}

function summarize(pi) {
  return {
    payment_intent_id: pi.id,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    // requires_capture 就是压住了，正是我们要的状态
    charge_id: pi.latest_charge || null,
  };
}

app.post('/api/hold', wrap(async function (req, res) {
  const experiment = Number(req.body.experiment);
  if (experiment !== 1 && experiment !== 2) {
    return res.status(400).json({ error: 'experiment 只能是 1 或 2' });
  }

  const state = loadState();
  if (!state.payment_method) {
    return res.status(400).json({ error: '还没存卡。先把上面那一步做完。' });
  }
  const open = state.runs.filter(function (r) {
    return r.experiment === experiment && !r.voided_at && !r.error && r.status !== 'canceled';
  })[0];
  if (open) {
    return res.status(400).json({
      error: '实验 ' + experiment + ' 已经有一笔挂着的 hold（' + open.payment_intent_id + '）。先 void 掉它，或者点刷新看看它现在什么状态。',
    });
  }

  const entry = {
    experiment: experiment,
    off_session: true,
    created_at: now(),
    confirmed_at: null,
    voided_at: null,
    void_due_at: experiment === 2 ? new Date(Date.now() + HOLD_HOURS * 3600 * 1000).toISOString() : null,
    bank_pending_seen_at: null,   // Eric 在银行 App 里看到 pending 出现
    bank_cleared_at: null,        // Eric 在银行 App 里看到 pending 消失
    notes: [],
    error: null,
  };

  try {
    const pi = await createHold(experiment);
    Object.assign(entry, summarize(pi));
    entry.confirmed_at = now();

    const s = loadState();
    s.runs.push(entry);
    saveState(s);

    // 实验 1：压完立刻 void，量的就是「最快能多快回来」
    if (experiment === 1 && pi.status === 'requires_capture') {
      const canceled = await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' });
      const s2 = loadState();
      const row = s2.runs.filter(function (r) { return r.payment_intent_id === pi.id; })[0];
      row.status = canceled.status;
      row.voided_at = now();
      saveState(s2);
      return res.json({ ok: true, entry: row });
    }

    return res.json({ ok: true, entry: entry });
  } catch (err) {
    // 被拒也是一个结论，不是崩溃。记下来。
    const raw = err && err.raw ? err.raw : {};
    const pi = raw.payment_intent || null;
    entry.error = {
      type: err.type || null,
      code: err.code || null,
      decline_code: err.decline_code || (raw && raw.decline_code) || null,
      message: err.message || String(err),
    };
    if (pi) {
      entry.payment_intent_id = pi.id;
      entry.status = pi.status;
    } else {
      entry.status = 'failed';
    }
    const s = loadState();
    s.runs.push(entry);
    saveState(s);
    return res.json({ ok: false, entry: entry });
  }
}));

// ---- 银行要 3DS 的时候，把这笔拉回前台做一次验证 ----
app.post('/api/client-secret', wrap(async function (req, res) {
  const id = String(req.body.payment_intent_id || '');
  if (!id) return res.status(400).json({ error: '缺 payment_intent_id' });
  const pi = await stripe.paymentIntents.retrieve(id);
  res.json({ client_secret: pi.client_secret, status: pi.status });
}));

// ---- void ----
app.post('/api/void', wrap(async function (req, res) {
  const id = String(req.body.payment_intent_id || '');
  if (!id) return res.status(400).json({ error: '缺 payment_intent_id' });

  const canceled = await stripe.paymentIntents.cancel(id, { cancellation_reason: 'abandoned' });
  const s = loadState();
  const row = s.runs.filter(function (r) { return r.payment_intent_id === id; })[0];
  if (row) {
    row.status = canceled.status;
    row.voided_at = now();
    saveState(s);
  }
  res.json({ ok: true, entry: row || summarize(canceled) });
}));

// ---- 打点：只有 Eric 能看见银行，所以观察结果由他按按钮记进来 ----
app.post('/api/observe', wrap(async function (req, res) {
  const id = String(req.body.payment_intent_id || '');
  const field = String(req.body.field || '');
  const allowed = ['bank_pending_seen_at', 'bank_cleared_at'];
  if (allowed.indexOf(field) === -1) return res.status(400).json({ error: 'field 不认识：' + field });

  const s = loadState();
  const row = s.runs.filter(function (r) { return r.payment_intent_id === id; })[0];
  if (!row) return res.status(404).json({ error: '没这笔：' + id });

  row[field] = req.body.clear ? null : now();
  if (req.body.note) row.notes.push({ at: now(), text: String(req.body.note) });
  saveState(s);
  res.json({ ok: true, entry: row });
}));

// ---- 刷新：回 Stripe 拉一次真实状态，别只信本地记录 ----
app.post('/api/refresh', wrap(async function (req, res) {
  const s = loadState();
  for (const row of s.runs) {
    if (!row.payment_intent_id) continue;
    try {
      const pi = await stripe.paymentIntents.retrieve(row.payment_intent_id);
      row.status = pi.status;
      // Stripe 侧已经取消、但本地没记 void 时间，补一个标记
      if (pi.status === 'canceled' && !row.voided_at) {
        row.voided_at = pi.canceled_at ? new Date(pi.canceled_at * 1000).toISOString() : now();
        row.notes.push({ at: now(), text: '刷新时发现 Stripe 侧已是 canceled，void 时间按 Stripe 的 canceled_at 补记' });
      }
    } catch (e) {
      row.notes.push({ at: now(), text: '刷新失败：' + e.message });
    }
  }
  saveState(s);
  res.json(s);
}));

// ---- 导出结论，给下一个 Agent 看的 ----
function fmtDelta(a, b) {
  if (!a || !b) return '未记录';
  const ms = new Date(b) - new Date(a);
  if (ms < 0) return '时间对不上（' + a + ' -> ' + b + '）';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h === 0) return m + ' 分钟';
  return h + ' 小时 ' + m + ' 分钟';
}

app.post('/api/report', wrap(async function (req, res) {
  const s = loadState();
  const lines = [];
  lines.push('# Break Enforcer 第 7 步实测结果');
  lines.push('');
  lines.push('> 模式：**' + s.mode + '**　生成时间：' + now());
  if (s.mode !== 'live') {
    lines.push('>');
    lines.push('> **这是 test mode 的结果，不作数。** test 是假钱，碰不到银行。');
  }
  lines.push('');
  if (s.payment_method) {
    lines.push('卡：' + s.payment_method.brand + ' ••••' + s.payment_method.last4 +
      '，funding=`' + s.payment_method.funding + '`，country=' + s.payment_method.country);
    if (s.payment_method.funding !== 'debit') {
      lines.push('');
      lines.push('**注意：这张卡的 funding 不是 debit。** Break_Enforcer_主应用.md 的已定规格是 debit，credit 卡只占额度、钱没离开账户，痛感弱，结论不可直接套用。');
    }
    lines.push('');
  }
  lines.push('| 实验 | PaymentIntent | 状态 | 压上 | void | 银行看到 pending | pending 消失 | 压住多久 | void 后多久回来 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of s.runs) {
    lines.push('| ' + r.experiment +
      ' | `' + (r.payment_intent_id || '无') +
      '` | ' + (r.error ? '失败：' + (r.error.decline_code || r.error.code || r.error.message) : r.status) +
      ' | ' + (r.confirmed_at || '未') +
      ' | ' + (r.voided_at || '未') +
      ' | ' + (r.bank_pending_seen_at || '未记录') +
      ' | ' + (r.bank_cleared_at || '未记录') +
      ' | ' + fmtDelta(r.confirmed_at, r.voided_at) +
      ' | ' + fmtDelta(r.voided_at, r.bank_cleared_at) + ' |');
  }
  lines.push('');
  lines.push('## 决策表（Break_Enforcer_主应用.md「银行实测结果」）');
  lines.push('');
  lines.push('| 测出来 | 怎么办 |');
  lines.push('|---|---|');
  lines.push('| 放开当天就回来，5 天也压得住 | 直接按现方案做 |');
  lines.push('| 放开要 2 天以上才回来 | 方案还能用，但要告诉 Eric「罚 5 天实际是 7 天」 |');
  lines.push('| 放开要一周以上 | 得换思路，重新讨论 |');
  lines.push('| 5 天撑不住，提前放了 | 需要在快过期时续压一次，逻辑变复杂但能做 |');
  lines.push('');
  lines.push('## 备注');
  lines.push('');
  let hasNote = false;
  for (const r of s.runs) {
    for (const n of (r.notes || [])) {
      hasNote = true;
      lines.push('- [' + (r.payment_intent_id || '实验 ' + r.experiment) + '] ' + n.at + '：' + n.text);
    }
    if (r.error) {
      hasNote = true;
      lines.push('- [' + (r.payment_intent_id || '实验 ' + r.experiment) + '] **off-session 授权失败**：' +
        (r.error.code || '') + ' / ' + (r.error.decline_code || '') + ' / ' + r.error.message);
    }
  }
  if (!hasNote) lines.push('- 无');
  lines.push('');

  const md = lines.join('\n');
  const file = path.join(RUNS_DIR, 'report.' + MODE + '.md');
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(file, md);
  res.json({ ok: true, file: file, markdown: md });
}));

app.listen(PORT, '127.0.0.1', function () {
  const banner = MODE === 'live'
    ? '*** LIVE MODE：真钱、真卡。每点一次「压款」都会真的动你的银行账户。 ***'
    : '--- TEST MODE：假钱。用 4242 4242 4242 4242 验证流程，结论不作数。 ---';
  console.log('');
  console.log(banner);
  console.log('');
  console.log('  打开 http://127.0.0.1:' + PORT);
  console.log('  金额固定：实验 1 $' + (AMOUNTS[1] / 100).toFixed(2) + '，实验 2 $' + (AMOUNTS[2] / 100).toFixed(2) + ' ' + CURRENCY.toUpperCase() + '，实验 2 的 hold 时长 ' + HOLD_HOURS + ' 小时');
  console.log('  记录存在 ' + STATE_FILE);
  console.log('');
  console.log('  Ctrl+C 结束。服务器关了不影响已经压住的 hold，下次开起来还在。');
  console.log('');
});

'use strict';

// 单页面，一个窗口走完：存卡 -> 两个实验 -> 打点 -> 导出结论。

var cfg = null;
var stripe = null;
var elements = null;

function $(id) { return document.getElementById(id); }

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) { return r.json(); });
}

function say(el, text, kind) {
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function local(iso) {
  if (!iso) return '未记录';
  var d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function delta(a, b) {
  if (!a || !b) return '未记录';
  var ms = new Date(b) - new Date(a);
  if (ms < 0) return '时间对不上';
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  var sec = Math.floor((ms % 60000) / 1000);
  if (h > 0) return h + ' 小时 ' + m + ' 分钟';
  if (m > 0) return m + ' 分 ' + sec + ' 秒';
  return sec + ' 秒';
}

function countdown(iso) {
  if (!iso) return '';
  var ms = new Date(iso) - Date.now();
  if (ms <= 0) return '已到点，可以 void 了';
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  return '还差 ' + h + ' 小时 ' + m + ' 分钟到点';
}

// ---------- 启动 ----------
fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
  cfg = c;
  var badge = $('mode-badge');
  badge.textContent = c.mode === 'live' ? 'LIVE　真钱真卡' : 'TEST　假钱，结论不作数';
  badge.className = 'badge ' + c.mode;
  $('hold-hours').textContent = c.hold_hours;
  stripe = Stripe(c.publishable_key);
  return refresh();
}).catch(function (e) {
  document.body.insertAdjacentHTML('afterbegin',
    '<p class="msg err">起不来：' + e.message + '</p>');
});

// ---------- 存卡 ----------
function mountCardForm() {
  return post('/api/setup-intent').then(function (data) {
    if (data.error) throw new Error(data.error);
    elements = stripe.elements({ clientSecret: data.client_secret });
    var pe = elements.create('payment');
    pe.mount('#payment-element');
    $('save-card-btn').disabled = false;
  });
}

$('save-card-btn').addEventListener('click', function () {
  var btn = $('save-card-btn');
  btn.disabled = true;
  say($('card-msg'), '正在存卡，可能会弹一次银行验证……');

  stripe.confirmSetup({ elements: elements, redirect: 'if_required' }).then(function (res) {
    if (res.error) {
      say($('card-msg'), '存卡失败：' + res.error.message, 'err');
      btn.disabled = false;
      return;
    }
    return post('/api/card-saved', { setup_intent_id: res.setupIntent.id }).then(function (data) {
      if (data.error) {
        say($('card-msg'), data.error, 'err');
        btn.disabled = false;
        return;
      }
      say($('card-msg'), '', '');
      return refresh();
    });
  });
});

$('resave').addEventListener('click', function (e) {
  e.preventDefault();
  $('card-form').classList.remove('hidden');
  $('save-card-btn').disabled = true;
  mountCardForm();
});

// ---------- 实验 ----------
function runExperiment(n) {
  var btn = $('exp' + n + '-btn');
  var msg = $('exp' + n + '-msg');
  btn.disabled = true;
  say(msg, '正在压款……');

  return post('/api/hold', { experiment: n }).then(function (data) {
    if (data.error) { say(msg, data.error, 'err'); btn.disabled = false; return refresh(); }

    var e = data.entry;
    if (!data.ok) {
      if (e.status === 'requires_action') {
        say(msg, 'off-session 压不动，银行要求 3DS 验证。这本身就是一个重要结论，'
          + '说明主应用判罚时也可能被拦。下面那笔记录里有「补做验证」按钮。', 'err');
      } else {
        say(msg, '被拒了：' + (e.error.decline_code || e.error.code || '') + ' ' + e.error.message
          + '　（这也是结论，记下来了）', 'err');
      }
      return refresh();
    }

    if (n === 1) {
      say(msg, '压住又撤销了，前后 ' + delta(e.confirmed_at, e.voided_at)
        + '。现在去 RBC App 看，pending 消失的那一刻回来点「pending 消失了」。', 'ok');
    } else {
      say(msg, '压住了，状态 ' + e.status + '。到点之前别管它，下面有倒计时。', 'ok');
    }
    return refresh();
  });
}

$('exp1-btn').addEventListener('click', function () { runExperiment(1); });
$('exp2-btn').addEventListener('click', function () { runExperiment(2); });

// ---------- 渲染 ----------
function renderRuns(state) {
  var box = $('runs');
  if (!state.runs.length) {
    box.innerHTML = '<p class="hint">还没有任何实验记录。</p>';
    return;
  }
  box.innerHTML = '';
  state.runs.forEach(function (r) {
    var div = document.createElement('div');
    div.className = 'run';

    var rows = ''
      + '<dt>PaymentIntent</dt><dd><code>' + (r.payment_intent_id || '没建起来') + '</code></dd>'
      + '<dt>状态</dt><dd class="state-' + r.status + '">' + r.status + '</dd>'
      + '<dt>压上</dt><dd>' + local(r.confirmed_at) + '</dd>'
      + '<dt>void</dt><dd>' + local(r.voided_at) + '</dd>'
      + '<dt>压住多久</dt><dd>' + delta(r.confirmed_at, r.voided_at) + '</dd>'
      + '<dt>银行看到 pending</dt><dd>' + local(r.bank_pending_seen_at) + '</dd>'
      + '<dt>pending 消失</dt><dd>' + local(r.bank_cleared_at) + '</dd>'
      + '<dt><strong>void 后多久回来</strong></dt><dd><strong>' + delta(r.voided_at, r.bank_cleared_at) + '</strong></dd>';
    if (r.void_due_at && !r.voided_at) {
      rows += '<dt>到点时间</dt><dd>' + local(r.void_due_at) + '　' + countdown(r.void_due_at) + '</dd>';
    }
    if (r.error) {
      rows += '<dt>失败原因</dt><dd class="state-failed">'
        + [r.error.code, r.error.decline_code, r.error.message].filter(Boolean).join(' / ') + '</dd>';
    }

    var btns = '';
    if (r.payment_intent_id) {
      btns += '<button class="small" data-act="pending" data-id="' + r.payment_intent_id + '">银行里看到 pending 了</button>';
      btns += '<button class="small" data-act="cleared" data-id="' + r.payment_intent_id + '">pending 消失了</button>';
      if (r.status === 'requires_capture') {
        btns += '<button class="small" data-act="void" data-id="' + r.payment_intent_id + '">现在 void 掉</button>';
      }
      if (r.status === 'requires_action') {
        btns += '<button class="small" data-act="3ds" data-id="' + r.payment_intent_id + '">补做银行验证</button>';
      }
    }

    div.innerHTML = '<h3>实验 ' + r.experiment + (r.off_session ? '（off-session）' : '') + '</h3>'
      + '<dl>' + rows + '</dl><div class="row">' + btns + '</div>';
    box.appendChild(div);
  });
}

document.addEventListener('click', function (ev) {
  var b = ev.target.closest ? ev.target.closest('button[data-act]') : null;
  if (!b) return;
  var id = b.getAttribute('data-id');
  var act = b.getAttribute('data-act');
  b.disabled = true;

  if (act === 'pending') {
    post('/api/observe', { payment_intent_id: id, field: 'bank_pending_seen_at' }).then(refresh);
  } else if (act === 'cleared') {
    post('/api/observe', { payment_intent_id: id, field: 'bank_cleared_at' }).then(refresh);
  } else if (act === 'void') {
    post('/api/void', { payment_intent_id: id }).then(refresh);
  } else if (act === '3ds') {
    post('/api/client-secret', { payment_intent_id: id }).then(function (d) {
      return stripe.handleNextAction({ clientSecret: d.client_secret });
    }).then(refresh);
  }
});

function refresh() {
  return fetch('/api/state').then(function (r) { return r.json(); }).then(function (state) {
    var pm = state.payment_method;
    if (pm) {
      $('card-form').classList.add('hidden');
      $('resave-line').classList.remove('hidden');
      var warn = pm.funding === 'debit' ? ''
        : '　<span class="state-failed">注意：这张卡是 ' + pm.funding + '，不是 debit。文档定的是 debit，结论不能直接套。</span>';
      $('saved-card').classList.remove('hidden');
      $('saved-card').innerHTML = '已存：<strong>' + pm.brand + ' ••••' + pm.last4 + '</strong>　'
        + pm.funding + ' / ' + pm.country + warn;
      $('exp1-btn').disabled = false;
      $('exp2-btn').disabled = false;
    } else if (!elements) {
      mountCardForm();
    }
    renderRuns(state);
    return state;
  });
}

$('refresh-btn').addEventListener('click', function () {
  post('/api/refresh').then(function (s) { renderRuns(s); });
});

$('report-btn').addEventListener('click', function () {
  post('/api/report').then(function (d) {
    var pre = $('report');
    pre.classList.remove('hidden');
    pre.textContent = d.markdown + '\n\n（也已经写到 ' + d.file + '）';
  });
});

// Break Enforcer app: login, start a session, count down, take the check-in photo.
// The server judges everything. This page shows the server's state and sends photos;
// nothing it does on its own clock can change a result.
(() => {
  'use strict';

  // Enough detail for the vision model; anything bigger only costs upload time.
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.85;

  const $ = (id) => document.getElementById(id);

  // ---------- cloud: every network call goes through here ----------

  let sb = null;

  function supa() {
    if (!sb) {
      if (!window.supabase || !window.BE_CONFIG) throw offline();
      sb = window.supabase.createClient(window.BE_CONFIG.supabaseUrl, window.BE_CONFIG.supabaseKey, {
        auth: { detectSessionInUrl: false },
      });
    }
    return sb;
  }

  function offline() {
    const e = new Error('网络断了，连不上服务器');
    e.code = 'offline';
    return e;
  }

  const AUTH_MESSAGES = {
    invalid_credentials: '邮箱或密码不对',
    email_not_confirmed: '邮箱还没验证',
    user_already_exists: '这个邮箱已经注册过了，直接登录',
    weak_password: '密码太简单了，至少 6 位',
    over_email_send_rate_limit: '发得太频繁了，等一分钟再试',
    over_request_rate_limit: '试得太频繁了，等一会儿再试',
    otp_expired: '验证码不对，或者过期了',
    validation_failed: '邮箱格式不对',
    email_address_invalid: '邮箱格式不对',
    signup_disabled: '现在不开放注册',
  };

  // supabase-js returns { data, error } instead of throwing.
  function authResult({ data, error }) {
    if (!error) return data;
    if (error.name === 'AuthRetryableFetchError') throw offline();
    const e = new Error(AUTH_MESSAGES[error.code] || error.message);
    e.code = error.code;
    throw e;
  }

  const cloud = {
    async token() {
      const { data } = await supa().auth.getSession();
      return data.session?.access_token || null;
    },
    signIn: async (email, password) => authResult(await supa().auth.signInWithPassword({ email, password })),
    signUp: async (email, password) => authResult(await supa().auth.signUp({ email, password })),
    verifySignup: async (email, token) => authResult(await supa().auth.verifyOtp({ email, token, type: 'email' })),
    resendSignup: async (email) => authResult(await supa().auth.resend({ type: 'signup', email })),
    signOut: async () => authResult(await supa().auth.signOut()),

    async api(method, path, body) {
      const token = await cloud.token();
      if (!token) throw Object.assign(new Error('请先登录'), { status: 401 });
      let res;
      try {
        res = await fetch('/api/' + path, {
          method,
          headers: body
            ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
            : { authorization: 'Bearer ' + token },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw offline();
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(new Error(data.message || `出错了（${res.status}）`), { status: res.status, code: data.error });
      }
      return data;
    },
  };

  // ---------- state ----------

  let state = null; // the last /api/state answer
  let clockOffset = 0; // server time minus this phone's time
  let current = 'loading';

  const serverNow = () => Date.now() + clockOffset;
  function syncClock(iso) {
    if (iso) clockOffset = Date.parse(iso) - Date.now();
  }

  const SCREENS = ['loading', 'auth', 'home', 'session'];
  function show(name) {
    current = name;
    for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
    $('logout').hidden = name === 'auth' || name === 'loading';
  }

  function flash(id, text, ok = false) {
    const node = $(id);
    node.textContent = text || '';
    node.classList.toggle('ok', ok);
  }

  let refreshing = null;
  function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const s = await cloud.api('GET', 'state');
          syncClock(s.server_now);
          state = s;
          render();
        } catch (e) {
          if (e.status === 401) return showAuth();
          if (current === 'loading' || !state) return loadingError(e.message);
          flash(current === 'session' ? 'session-msg' : 'home-msg', e.message);
        } finally {
          refreshing = null;
        }
      })();
    }
    return refreshing;
  }

  function render() {
    if (state.active) {
      renderSession();
      show('session');
      startTicker();
    } else {
      stopTicker();
      renderHome();
      show('home');
    }
  }

  function loadingError(message) {
    show('loading');
    $('loading-msg').textContent = message;
    $('retry').hidden = false;
  }

  // ---------- formatting ----------

  function mmss(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function clock(value, seconds = false) {
    const d = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + (seconds ? ':' + pad(d.getSeconds()) : '');
  }

  function day(value) {
    const d = new Date(value);
    return d.getMonth() + 1 + '/' + d.getDate() + ' ' + clock(d);
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  const VERDICT_TEXT = { pass: '通过', fail: '没通过', error: '判定出错', pending: '判定中' };

  function sessionTag(s) {
    if (s.status === 'passed') return ['通过', 'tag-pass'];
    if (s.status === 'active') return ['进行中', ''];
    return [s.fail_reason === 'no_pass' ? '照片没通过' : '没交照片', 'tag-fail'];
  }

  // ---------- home ----------

  function renderHome() {
    const latest = state.latest;
    $('last').hidden = !latest;
    if (latest) {
      const passed = latest.status === 'passed';
      $('last-status').textContent = passed ? '通过 ✓' : '失败';
      $('last-status').className = 'big-status ' + (passed ? 'pass' : 'fail');
      const lastAttempt = state.attempts[state.attempts.length - 1];
      let detail;
      if (passed) {
        detail = `第一张照片 ${clock(latest.first_photo_at, true)} 交的，截止是 ${clock(latest.deadline_at, true)}。`;
      } else if (latest.fail_reason === 'no_photo') {
        detail = `${clock(latest.deadline_at, true)} 前没交照片。`;
      } else {
        detail = '照片都没通过比对。' + (lastAttempt?.reason ? `最后一张：${lastAttempt.reason}` : '');
      }
      if (!passed) detail += ' 扣款还没接上，这一轮不扣钱。';
      $('last-detail').textContent = detail;
    }

    renderStartLabel();
    const hasRefs = state.references.length > 0;
    $('start').disabled = !hasRefs;
    $('start-hint').textContent = hasRefs
      ? `点了就不能取消。${mmss(state.timing.relax * 1000)} 后开始倒数 ${mmss(state.timing.buffer * 1000)}，这期间到 7 楼交第一张照片。`
      : '先在下面存一张 7 楼参考照，才能开始。';

    const refs = $('refs');
    refs.replaceChildren();
    if (!hasRefs) refs.append(el('div', { className: 'refs-empty', textContent: '还没有参考照' }));
    for (const r of state.references) {
      const del = el('button', { type: 'button', textContent: '删除' });
      del.onclick = () => deleteReference(r.id, del);
      refs.append(el('div', { className: 'ref' }, el('img', { src: r.url || '', alt: '参考照', loading: 'lazy' }), del));
    }
    const full = state.references.length >= 6;
    $('ref-camera').disabled = full;
    $('ref-file').disabled = full;

    const history = $('history');
    history.replaceChildren();
    if (state.history.length === 0) history.append(el('li', {}, el('span', { className: 'dim', textContent: '还没有记录' })));
    for (const s of state.history) {
      const [text, cls] = sessionTag(s);
      history.append(el('li', {}, el('span', { className: 'when', textContent: day(s.started_at) }), el('span', { className: cls, textContent: text })));
    }
  }

  function renderStartLabel() {
    $('start').textContent = '开始放松 ' + mmss((state?.timing.relax ?? 2725) * 1000);
  }

  // Two taps to start: an accidental tap would lock in a 50 minute session.
  let startArmedAt = 0;
  $('start').onclick = async () => {
    if (Date.now() - startArmedAt > 4000) {
      startArmedAt = Date.now();
      $('start').textContent = '确定开始？再点一次';
      setTimeout(() => {
        if (startArmedAt && Date.now() - startArmedAt >= 4000) renderStartLabel();
      }, 4100);
      return;
    }
    startArmedAt = 0;
    $('start').disabled = true;
    flash('home-msg', '');
    try {
      const r = await cloud.api('POST', 'start');
      syncClock(r.server_now);
      await refresh();
    } catch (e) {
      flash('home-msg', e.message);
      renderStartLabel();
      $('start').disabled = false;
    }
  };

  async function deleteReference(id, button) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = '确定删？';
      setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = '删除';
      }, 3000);
      return;
    }
    button.disabled = true;
    try {
      await cloud.api('DELETE', 'references?id=' + encodeURIComponent(id));
      await refresh();
    } catch (e) {
      flash('home-msg', e.message);
      button.disabled = false;
    }
  }

  async function saveReference(dataUrl) {
    await cloud.api('POST', 'references', { image: dataUrl.split(',')[1] });
    await refresh();
    flash('home-msg', '参考照存好了', true);
  }

  // Picking from the album is fine for the reference; check-ins only ever use the live camera.
  $('ref-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    flash('home-msg', '保存中…', true);
    try {
      await saveReference(await fileToJpeg(file));
    } catch (e) {
      flash('home-msg', e.message);
    }
  };
  $('ref-camera').onclick = () => openCamera('reference');

  // ---------- session ----------

  let ticker = null;
  let lastOverdueRefresh = 0;

  function startTicker() {
    if (!ticker) ticker = setInterval(tick, 250);
    tick();
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  function renderSession() {
    const attempts = state.attempts;
    const last = attempts[attempts.length - 1];
    const box = $('attempt-result');
    box.hidden = !last;
    if (last) {
      box.className = 'result ' + last.verdict;
      $('attempt-title').textContent = VERDICT_TEXT[last.verdict] || last.verdict;
      $('attempt-reason').textContent = last.reason || '';
    }
    const list = $('attempts');
    list.replaceChildren();
    for (const a of attempts.slice(0, -1).reverse()) {
      list.append(
        el('li', {},
          el('span', { className: 'when', textContent: clock(a.submitted_at, true) }),
          el('span', { className: a.verdict === 'pass' ? 'tag-pass' : 'tag-fail', textContent: VERDICT_TEXT[a.verdict] || a.verdict }),
        ),
      );
    }
    renderRefRow($('session-refs-row'), (ref) => {
      $('peek-img').src = ref.url;
      $('peek').hidden = false;
    });
    $('session-refs').hidden = state.references.length === 0;
    flash('session-msg', '');
    tick();
  }

  // One button per reference photo, used on the session screen and inside the camera.
  function renderRefRow(row, onPick) {
    row.replaceChildren();
    for (const ref of state.references) {
      const button = el('button', { type: 'button', title: '参考照' }, el('img', { src: ref.url || '', alt: '参考照' }));
      button.onclick = () => onPick(ref, button);
      row.append(button);
    }
  }

  $('peek').onclick = () => {
    $('peek').hidden = true;
  };

  function tick() {
    const s = state?.active;
    if (!s) return;
    const now = serverNow();
    const relaxEnd = Date.parse(s.relax_ends_at);
    const deadline = Date.parse(s.deadline_at);
    const timer = $('timer');
    const arrived = $('arrived');
    let label;
    let left;
    let sub;
    let mode = '';

    if (s.first_photo_at) {
      left = Date.parse(s.retake_until) - now;
      label = '已停表';
      mode = 'stopped';
      sub = left > 0 ? '照片已经交了。判错了可以重拍，重拍不算时间。' : '重拍时间到了，等服务器收尾。';
      arrived.textContent = '重拍一张';
      arrived.hidden = left <= 0;
    } else if (now < relaxEnd) {
      left = relaxEnd - now;
      label = '放松中';
      sub = `${clock(relaxEnd)} 到点 · ${clock(deadline, true)} 前交第一张照片`;
      arrived.textContent = '我到了 · 开相机';
      arrived.hidden = false;
    } else {
      left = deadline - now;
      label = '下楼拍照';
      mode = 'alarm';
      sub = `${clock(deadline, true)} 前交第一张照片`;
      arrived.textContent = '我到了 · 开相机';
      arrived.hidden = left <= 0;
      if (left <= 0) sub = '过了截止时间，等服务器收尾。';
    }

    $('phase-label').textContent = label;
    timer.textContent = mmss(left);
    timer.className = 'timer ' + mode;
    $('timer-sub').textContent = sub;

    // Time is up on this phone's view: ask the server, which makes the actual call.
    if (left <= 0 && Date.now() - lastOverdueRefresh > 5000) {
      lastOverdueRefresh = Date.now();
      refresh();
    }
  }

  $('arrived').onclick = () => openCamera('checkin');

  // ---------- camera ----------

  let stream = null;
  let camMode = null;
  let shot = null;
  let ghostUrl = null; // the reference laid over the viewfinder, if any

  async function openCamera(mode) {
    camMode = mode;
    shot = null;
    ghostUrl = null;
    const guide = mode === 'checkin' && state.references.length > 0;
    $('cam-refs').hidden = !guide;
    if (guide) renderRefRow($('cam-refs-row'), toggleGhost);
    camUi('live');
    $('screen-camera').hidden = false;
    $('cam-msg').textContent =
      mode === 'checkin'
        ? '拍成跟参考照一样的角度。点左下角的参考照，它会半透明叠在画面上，对齐了再拍'
        : '拍 7 楼那个固定景观，别拍到人。挑有特色的角度：挂画、家具、招牌，光有白墙和百叶窗不行';
    if (!navigator.mediaDevices?.getUserMedia) {
      $('cam-msg').textContent = '这个页面开不了摄像头，要用 https 地址打开';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      const video = $('video');
      video.srcObject = stream;
      await video.play().catch(() => {});
    } catch (e) {
      $('cam-msg').textContent =
        e.name === 'NotAllowedError'
          ? '没有摄像头权限。iPhone 上：设置 → Safari → 相机，改成「允许」'
          : '打不开摄像头：' + e.message;
    }
  }

  function closeCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    $('video').srcObject = null;
    $('screen-camera').hidden = true;
  }

  function toggleGhost(ref, button) {
    ghostUrl = ghostUrl === ref.url ? null : ref.url;
    for (const b of $('cam-refs-row').children) b.classList.toggle('on', b === button && ghostUrl !== null);
    if (ghostUrl) $('ghost').src = ghostUrl;
    $('ghost').hidden = !ghostUrl || !$('still').hidden;
  }

  // live: viewfinder · shot: reviewing the photo · busy: sending it
  function camUi(phase) {
    const live = phase === 'live';
    $('video').hidden = !live;
    $('ghost').hidden = !live || !ghostUrl;
    $('still').hidden = live;
    $('cam-cancel').hidden = !live;
    $('cam-shoot').hidden = !live;
    $('cam-spacer').hidden = !live;
    $('cam-retake').hidden = live;
    $('cam-use').hidden = live;
    $('cam-retake').disabled = phase === 'busy';
    $('cam-use').disabled = phase === 'busy';
  }

  $('cam-shoot').onclick = () => {
    const video = $('video');
    if (!video.videoWidth) return;
    shot = frameToJpeg(video, video.videoWidth, video.videoHeight);
    $('still').src = shot;
    $('cam-msg').textContent = '';
    camUi('shot');
  };

  $('cam-retake').onclick = () => {
    shot = null;
    camUi('live');
  };

  $('cam-cancel').onclick = closeCamera;

  $('cam-use').onclick = async () => {
    camUi('busy');
    if (camMode === 'reference') {
      $('cam-msg').textContent = '保存中…';
      try {
        await saveReference(shot);
        closeCamera();
      } catch (e) {
        $('cam-msg').textContent = e.message;
        camUi('shot');
      }
      return;
    }

    $('cam-msg').textContent = 'AI 判定中，几秒钟…';
    try {
      const r = await cloud.api('POST', 'photo', { session_id: state.active.id, image: shot.split(',')[1] });
      syncClock(r.server_now);
      closeCamera();
      await refresh();
    } catch (e) {
      if (['session_closed', 'too_late', 'retake_over', 'session_not_found'].includes(e.code)) {
        closeCamera();
        await refresh();
        flash(current === 'session' ? 'session-msg' : 'home-msg', e.message);
        return;
      }
      $('cam-msg').textContent = e.message;
      camUi('shot');
    }
  };

  // ---------- images ----------

  function frameToJpeg(source, width, height) {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  function fileToJpeg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(frameToJpeg(img, img.naturalWidth, img.naturalHeight));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图打不开，换一张试试'));
      };
      img.src = url;
    });
  }

  // ---------- login ----------

  let authMode = 'login';
  let pendingEmail = '';

  function showAuth(message) {
    stopTicker();
    closeCamera();
    state = null;
    show('auth');
    $('auth-form').hidden = false;
    $('code-form').hidden = true;
    flash('auth-msg', message || '');
  }

  function setAuthMode(mode) {
    authMode = mode;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.mode === mode);
    $('auth-submit').textContent = mode === 'login' ? '登录' : '注册';
    $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    flash('auth-msg', '');
  }

  function showCode(email) {
    pendingEmail = email;
    $('code-email').textContent = email;
    $('code-input').value = '';
    $('auth-form').hidden = true;
    $('code-form').hidden = false;
  }

  async function afterLogin() {
    $('auth-password').value = '';
    show('loading');
    $('loading-msg').textContent = '载入中…';
    await refresh();
  }

  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setAuthMode(b.dataset.mode);

  $('auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password) return flash('auth-msg', '邮箱和密码都要填');
    if (password.length < 6) return flash('auth-msg', '密码至少 6 位');
    $('auth-submit').disabled = true;
    try {
      if (authMode === 'login') {
        try {
          await cloud.signIn(email, password);
        } catch (e) {
          if (e.code !== 'email_not_confirmed') throw e;
          await cloud.resendSignup(email).catch(() => {});
          return showCode(email);
        }
      } else {
        const data = await cloud.signUp(email, password);
        if (!data.session) {
          // An already registered email comes back as a user with no identities, and no email is sent.
          if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
            setAuthMode('login');
            return flash('auth-msg', '这个邮箱已经注册过了，直接登录');
          }
          return showCode(email);
        }
      }
      await afterLogin();
    } catch (e) {
      flash('auth-msg', e.message);
    } finally {
      $('auth-submit').disabled = false;
    }
  };

  $('code-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await cloud.verifySignup(pendingEmail, $('code-input').value.trim());
      await afterLogin();
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('code-resend').onclick = async () => {
    try {
      await cloud.resendSignup(pendingEmail);
      flash('auth-msg', '重发了', true);
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('code-back').onclick = () => showAuth();

  $('logout').onclick = async () => {
    try {
      await cloud.signOut();
    } catch {
      // Signed out locally either way.
    }
    showAuth();
  };

  $('retry').onclick = () => {
    $('retry').hidden = true;
    $('loading-msg').textContent = '载入中…';
    boot();
  };

  // ---------- start ----------

  async function boot() {
    try {
      if (!(await cloud.token())) return showAuth();
      await refresh();
    } catch (e) {
      loadingError(e.message);
    }
  }

  // Coming back to the home screen app after a while: the server may have moved on.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state) refresh();
  });

  try {
    supa().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && current !== 'auth') showAuth();
    });
  } catch {
    // Handled by boot(), which shows the offline message.
  }
  boot();
})();

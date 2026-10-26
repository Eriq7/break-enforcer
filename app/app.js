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
    const e = new Error("You're offline. Can't reach the server.");
    e.code = 'offline';
    return e;
  }

  const AUTH_MESSAGES = {
    invalid_credentials: 'Wrong email or password',
    email_not_confirmed: 'Your email is not verified yet',
    user_already_exists: 'This email is already registered. Log in instead.',
    weak_password: 'Password is too weak. Use at least 6 characters.',
    over_email_send_rate_limit: 'Too many emails. Wait a minute and try again.',
    over_request_rate_limit: 'Too many tries. Wait a moment and try again.',
    otp_expired: 'That code is wrong or has expired',
    validation_failed: "That email address doesn't look right",
    email_address_invalid: "That email address doesn't look right",
    signup_disabled: 'Sign-ups are closed right now',
    same_password: 'The new password must be different from the old one',
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
    sendReset: async (email) => authResult(await supa().auth.resetPasswordForEmail(email)),
    verifyReset: async (email, token) => authResult(await supa().auth.verifyOtp({ email, token, type: 'recovery' })),
    setPassword: async (password) => authResult(await supa().auth.updateUser({ password })),
    signOut: async () => authResult(await supa().auth.signOut()),

    async api(method, path, body) {
      const token = await cloud.token();
      if (!token) throw Object.assign(new Error('Please log in first'), { status: 401 });
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
        throw Object.assign(new Error(data.message || `Something went wrong (${res.status})`), { status: res.status, code: data.error });
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

  const VERDICT_TEXT = { pass: 'Passed', fail: 'Failed', error: 'Check error', pending: 'Checking' };

  function sessionTag(s) {
    if (s.status === 'passed') return ['Passed', 'tag-pass'];
    if (s.status === 'active') return ['In progress', ''];
    return [s.fail_reason === 'no_pass' ? 'Photo failed' : 'No photo', 'tag-fail'];
  }

  // ---------- home ----------

  function renderHome() {
    const latest = state.latest;
    $('last').hidden = !latest;
    if (latest) {
      const passed = latest.status === 'passed';
      $('last-status').textContent = passed ? 'Passed ✓' : 'Failed';
      $('last-status').className = 'big-status ' + (passed ? 'pass' : 'fail');
      const lastAttempt = state.attempts[state.attempts.length - 1];
      let detail;
      if (passed) {
        detail = `First photo at ${clock(latest.first_photo_at, true)}. The deadline was ${clock(latest.deadline_at, true)}.`;
      } else if (latest.fail_reason === 'no_photo') {
        detail = `No photo before ${clock(latest.deadline_at, true)}.`;
      } else {
        detail = 'No photo passed the check.' + (lastAttempt?.reason ? ` Last one: ${lastAttempt.reason}` : '');
      }
      if (!passed) detail += " Payments aren't connected yet, so nothing was charged.";
      $('last-detail').textContent = detail;
    }

    renderStartLabel();
    const hasRefs = state.references.length > 0;
    $('start').disabled = !hasRefs;
    $('start-hint').textContent = hasRefs
      ? `Once started, it can't be cancelled. After ${mmss(state.timing.relax * 1000)}, you get ${mmss(state.timing.buffer * 1000)} to take your first photo at the check-in spot.`
      : 'Save a check-in spot photo below before you start.';

    const refs = $('refs');
    refs.replaceChildren();
    if (!hasRefs) refs.append(el('div', { className: 'refs-empty', textContent: 'No check-in spot photos yet' }));
    for (const r of state.references) {
      const del = el('button', { type: 'button', textContent: 'Delete' });
      del.onclick = () => deleteReference(r.id, del);
      refs.append(el('div', { className: 'ref' }, el('img', { src: r.url || '', alt: 'Reference photo', loading: 'lazy' }), del));
    }
    const full = state.references.length >= 6;
    $('ref-camera').disabled = full;
    $('ref-file').disabled = full;

    const history = $('history');
    history.replaceChildren();
    if (state.history.length === 0) history.append(el('li', {}, el('span', { className: 'dim', textContent: 'Nothing yet' })));
    for (const s of state.history) {
      const [text, cls] = sessionTag(s);
      history.append(el('li', {}, el('span', { className: 'when', textContent: day(s.started_at) }), el('span', { className: cls, textContent: text })));
    }
  }

  function renderStartLabel() {
    $('start').textContent = 'Start break ' + mmss((state?.timing.relax ?? 2725) * 1000);
  }

  // Two taps to start: an accidental tap would lock in a 50 minute session.
  let startArmedAt = 0;
  $('start').onclick = async () => {
    if (Date.now() - startArmedAt > 4000) {
      startArmedAt = Date.now();
      $('start').textContent = 'Sure? Tap again to start';
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
      button.textContent = 'Delete?';
      setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = 'Delete';
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
    flash('home-msg', 'Photo saved', true);
  }

  // Picking from the album is fine for the reference; check-ins only ever use the live camera.
  $('ref-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    flash('home-msg', 'Saving…', true);
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
      const button = el('button', { type: 'button', title: 'Reference photo' }, el('img', { src: ref.url || '', alt: 'Reference photo' }));
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
      label = 'Clock stopped';
      mode = 'stopped';
      sub = left > 0 ? "Photo submitted. If the AI got it wrong, retake it. Retakes don't count against you." : 'Retake time is over. Wrapping up…';
      arrived.textContent = 'Retake';
      arrived.hidden = left <= 0;
    } else if (now < relaxEnd) {
      left = relaxEnd - now;
      label = 'On break';
      sub = `Break ends ${clock(relaxEnd)} · First photo due by ${clock(deadline, true)}`;
      arrived.textContent = "I'm here · Open camera";
      arrived.hidden = false;
    } else {
      left = deadline - now;
      label = 'Go check in';
      mode = 'alarm';
      sub = `First photo due by ${clock(deadline, true)}`;
      arrived.textContent = "I'm here · Open camera";
      arrived.hidden = left <= 0;
      if (left <= 0) sub = 'Past the deadline. Wrapping up…';
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
        ? 'Match the angle of your reference photo. Tap one at the bottom left to lay it over the view, line it up, then shoot.'
        : 'Shoot the fixed scene at your check-in spot, with no people in it. Pick a distinctive angle with art, furniture or signs. Plain walls and blinds are not enough.';
    if (!navigator.mediaDevices?.getUserMedia) {
      $('cam-msg').textContent = "This page can't use the camera. Open it from an https address.";
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
          ? 'No camera access. On iPhone: Settings → Safari → Camera → Allow.'
          : "Can't open the camera: " + e.message;
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
      $('cam-msg').textContent = 'Saving…';
      try {
        await saveReference(shot);
        closeCamera();
      } catch (e) {
        $('cam-msg').textContent = e.message;
        camUi('shot');
      }
      return;
    }

    $('cam-msg').textContent = 'The AI is checking. A few seconds…';
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
        reject(new Error("Can't open this image. Try another one."));
      };
      img.src = url;
    });
  }

  // ---------- login ----------

  let authMode = 'login';
  let pendingEmail = '';
  let resetEmail = '';

  function showAuth(message) {
    stopTicker();
    closeCamera();
    state = null;
    show('auth');
    $('auth-form').hidden = false;
    $('code-form').hidden = true;
    $('reset-form').hidden = true;
    flash('auth-msg', message || '');
  }

  function setAuthMode(mode) {
    authMode = mode;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.mode === mode);
    $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
    $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('forgot').hidden = mode !== 'login';
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
    $('loading-msg').textContent = 'Loading…';
    await refresh();
  }

  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setAuthMode(b.dataset.mode);

  $('auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password) return flash('auth-msg', 'Enter your email and password');
    if (password.length < 6) return flash('auth-msg', 'Password needs at least 6 characters');
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
            return flash('auth-msg', 'This email is already registered. Log in instead.');
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
      flash('auth-msg', 'Sent again', true);
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('code-back').onclick = () => showAuth();

  // Forgot password: a code by email, then a new password. The code also signs the user in.
  function showReset(email) {
    resetEmail = email;
    $('reset-email').textContent = email;
    $('reset-code').value = '';
    $('reset-password').value = '';
    $('auth-form').hidden = true;
    $('reset-form').hidden = false;
  }

  $('forgot').onclick = async () => {
    const email = $('auth-email').value.trim();
    if (!email) return flash('auth-msg', 'Enter your email above first');
    try {
      await cloud.sendReset(email);
      flash('auth-msg', '');
      showReset(email);
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('reset-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const password = $('reset-password').value;
    if (password.length < 6) return flash('auth-msg', 'New password needs at least 6 characters');
    try {
      // A code works once. If the new password was rejected after the code went through,
      // the user is already signed in, so only the password is retried.
      if (!(await cloud.token())) await cloud.verifyReset(resetEmail, $('reset-code').value.trim());
      await cloud.setPassword(password);
      $('reset-password').value = '';
      await afterLogin();
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('reset-resend').onclick = async () => {
    try {
      await cloud.sendReset(resetEmail);
      flash('auth-msg', 'Sent again', true);
    } catch (e) {
      flash('auth-msg', e.message);
    }
  };

  $('reset-back').onclick = async () => {
    // Leaving halfway after the code went through would otherwise keep that sign-in.
    await cloud.signOut().catch(() => {});
    showAuth();
  };

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
    $('loading-msg').textContent = 'Loading…';
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

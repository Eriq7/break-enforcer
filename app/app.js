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
      const arriving = current !== 'session';
      renderSession();
      show('session');
      if (arriving) windUpRing();
      startTicker();
    } else {
      stopTicker();
      $('spot-picker').hidden = true;
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

  // "Today, 15:21", "Yesterday, 21:04", "Oct 24, 09:30"
  function day(value) {
    const d = new Date(value);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const daysAgo = Math.floor((midnight - d) / 86400000) + 1;
    let date;
    if (daysAgo <= 0) date = 'Today';
    else if (daysAgo === 1) date = 'Yesterday';
    else date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return date + ', ' + clock(d);
  }

  // 300 seconds reads as "5 minutes", 90 as "90 seconds".
  function duration(seconds) {
    if (seconds % 60 !== 0) return seconds + ' seconds';
    const m = seconds / 60;
    return m === 1 ? '1 minute' : m + ' minutes';
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

  // Spots you can check in at: the ones with at least one photo.
  const usableSpots = () => state.spots.filter((p) => p.references.length > 0);
  const photoCount = (n) => (n === 1 ? '1 photo' : n + ' photos');

  // Deleting takes two taps. True on the second one.
  function confirmed(button, question) {
    if (button.classList.contains('armed')) return true;
    const label = button.textContent;
    button.classList.add('armed');
    button.textContent = question;
    setTimeout(() => {
      button.classList.remove('armed');
      button.textContent = label;
    }, 3000);
    return false;
  }

  // ---------- home ----------

  function renderHome() {
    const latest = state.latest;
    $('last').hidden = !latest;
    if (latest) {
      const passed = latest.status === 'passed';
      $('last-status').textContent = passed ? 'Last break passed' : 'Last break failed';
      $('last').className = 'last ' + (passed ? 'pass' : 'fail');
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
    $('hero-time').textContent = mmss(state.timing.relax * 1000);
    $('hero-sub').textContent = `then ${duration(state.timing.buffer)} to check in`;
    const hasRefs = usableSpots().length > 0;
    $('start').disabled = !hasRefs;
    $('start-hint').textContent = hasRefs
      ? `Once started, a break can't be cancelled. When it ends, you have ${duration(state.timing.buffer)} to take a photo at your check-in spot.`
      : 'Add a check-in spot with a photo below before you start.';

    renderSpots();
    renderTelegram();

    const history = $('history');
    history.replaceChildren();
    if (state.history.length === 0) history.append(el('li', {}, el('span', { className: 'dim', textContent: 'Nothing yet' })));
    for (const s of state.history) {
      const [text, cls] = sessionTag(s);
      history.append(el('li', {}, el('span', { className: 'when', textContent: day(s.started_at) }), el('span', { className: cls, textContent: text })));
    }
  }

  function renderStartLabel() {
    $('start').textContent = 'Start break';
  }

  // Two taps to start: an accidental tap would lock in a 50 minute session.
  let startArmedAt = 0;
  $('start').onclick = async () => {
    if (Date.now() - startArmedAt > 4000) {
      startArmedAt = Date.now();
      $('start').textContent = 'Tap again to start';
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

  // Each spot: its name, its photos, and buttons to add more.
  function renderSpots() {
    const box = $('spots');
    box.replaceChildren();
    if (state.spots.length === 0) {
      box.append(el('div', { className: 'refs-empty spots-empty', textContent: 'No check-in spots yet. Name one below, then add a photo of it.' }));
    }
    for (const spot of state.spots) {
      const refs = el('div', { className: 'refs' });
      if (spot.references.length === 0) refs.append(el('div', { className: 'refs-empty', textContent: 'No photos yet' }));
      for (const r of spot.references) {
        const del = el('button', { type: 'button', textContent: 'Delete' });
        del.onclick = () => deleteReference(r.id, del);
        refs.append(el('div', { className: 'ref' }, el('img', { src: r.url || '', alt: 'Reference photo', loading: 'lazy' }), del));
      }
      const full = spot.references.length >= 6;
      const camera = el('button', { type: 'button', className: 'btn btn-gray', textContent: 'Take photo', disabled: full });
      camera.onclick = () => openCamera('reference', spot);
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true, disabled: full });
      file.onchange = (ev) => chooseReference(ev, spot);
      const delSpot = el('button', { type: 'button', className: 'text-btn', textContent: 'Delete spot' });
      delSpot.onclick = () => deleteSpot(spot.id, delSpot);
      box.append(
        el('div', { className: 'spot' },
          el('div', { className: 'spot-head' }, el('h3', { className: 'spot-name', textContent: spot.name }), delSpot),
          refs,
          el('div', { className: 'row' }, camera, el('label', { className: 'btn btn-gray file' }, 'Choose photo', file)),
        ),
      );
    }
  }

  $('add-spot').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $('spot-name').value.trim();
    if (!name) return flash('spots-msg', 'Give the spot a name first');
    $('add-spot-btn').disabled = true;
    try {
      await cloud.api('POST', 'spots', { name });
      $('spot-name').value = '';
      await refresh();
      flash('spots-msg', `Added ${name}. Now add a photo of it.`, true);
    } catch (e) {
      flash('spots-msg', e.message);
    } finally {
      $('add-spot-btn').disabled = false;
    }
  };

  async function deleteSpot(id, button) {
    if (!confirmed(button, 'Delete it and its photos?')) return;
    button.disabled = true;
    try {
      await cloud.api('DELETE', 'spots?id=' + encodeURIComponent(id));
      await refresh();
    } catch (e) {
      flash('spots-msg', e.message);
      button.disabled = false;
    }
  }

  async function deleteReference(id, button) {
    if (!confirmed(button, 'Delete?')) return;
    button.disabled = true;
    try {
      await cloud.api('DELETE', 'references?id=' + encodeURIComponent(id));
      await refresh();
    } catch (e) {
      flash('spots-msg', e.message);
      button.disabled = false;
    }
  }

  async function saveReference(dataUrl, spot) {
    await cloud.api('POST', 'references', { spot_id: spot.id, image: dataUrl.split(',')[1] });
    await refresh();
    flash('spots-msg', `Photo saved to ${spot.name}`, true);
  }

  // Picking from the album is fine for the reference; check-ins only ever use the live camera.
  async function chooseReference(ev, spot) {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    flash('spots-msg', 'Saving…', true);
    try {
      await saveReference(await fileToJpeg(file), spot);
    } catch (e) {
      flash('spots-msg', e.message);
    }
  }

  // ---------- Telegram reminder ----------

  let tgOpening = false; // sent the user off to tap Start in Telegram

  function renderTelegram() {
    $('tg-connect').textContent = state.telegram ? 'Reconnect' : 'Connect';
    $('tg-note').textContent = state.telegram
      ? 'Connected. Telegram messages you 5 minutes before a break ends, even when this app is closed.'
      : 'Get a Telegram message 5 minutes before a break ends, even when this app is closed. Needs the Telegram app.';
    if (tgOpening && state.telegram) {
      tgOpening = false;
      flash('tg-msg', 'Telegram connected', true);
    }
  }

  $('tg-connect').onclick = async () => {
    $('tg-connect').disabled = true;
    try {
      const r = await cloud.api('POST', 'telegram');
      tgOpening = true;
      flash('tg-msg', 'Opening Telegram. Tap Start there, then come back.', true);
      location.href = r.url;
    } catch (e) {
      flash('tg-msg', e.message);
    } finally {
      $('tg-connect').disabled = false;
    }
  };

  // ---------- session ----------

  let ticker = null;
  let lastOverdueRefresh = 0;
  const RING_LENGTH = 590.62; // 2πr for the ring's r = 94, same as stroke-dasharray in the CSS

  // Opening a session: the ring starts empty and winds up to the time left.
  function windUpRing() {
    const dial = $('dial');
    const ring = $('ring');
    const target = ring.style.strokeDashoffset;
    dial.classList.remove('enter');
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = String(RING_LENGTH);
    void ring.getBoundingClientRect();
    ring.style.transition = '';
    dial.classList.add('enter');
    ring.style.strokeDashoffset = target;
    setTimeout(() => dial.classList.remove('enter'), 1200);
  }

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
      const where = state.spots.length > 1 ? state.spots.find((p) => p.id === last.spot_id)?.name : null;
      $('attempt-title').textContent = (VERDICT_TEXT[last.verdict] || last.verdict) + (where ? ' · ' + where : '');
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
    const spots = usableSpots();
    const group = $('session-spots');
    group.replaceChildren();
    for (const spot of spots) {
      const row = el('div', { className: 'session-refs-row' });
      renderRefRow(row, spot.references, (ref) => {
        $('peek-img').src = ref.url;
        $('peek').hidden = false;
      });
      if (spots.length > 1) group.append(el('p', { className: 'spot-label', textContent: spot.name }));
      group.append(row);
    }
    $('session-refs').hidden = spots.length === 0;
    flash('session-msg', '');
    tick();
  }

  // One button per reference photo, used on the session screen and inside the camera.
  function renderRefRow(row, refs, onPick) {
    row.replaceChildren();
    for (const ref of refs) {
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
    let from; // when the current phase began, for the ring
    let until; // when it ends
    let sub;
    let ends = ''; // the time beside the bell
    let mode = '';
    let button = 'btn-primary';

    if (s.first_photo_at) {
      from = Date.parse(s.first_photo_at);
      until = Date.parse(s.retake_until);
      label = 'Clock stopped';
      mode = 'stopped';
      sub = until > now ? "Photo submitted. If the AI got it wrong, retake it. Retakes don't count against you." : 'Retake time is over. Wrapping up…';
      arrived.textContent = 'Retake photo';
      button = 'btn-gray';
    } else if (now < relaxEnd) {
      from = Date.parse(s.started_at);
      until = relaxEnd;
      label = 'Break';
      ends = clock(relaxEnd);
      sub = `Then take a photo at your check-in spot by ${clock(deadline, true)}. You can go early.`;
      arrived.textContent = 'Take check-in photo';
    } else {
      from = relaxEnd;
      until = deadline;
      label = 'Check in now';
      mode = 'alarm';
      ends = clock(deadline, true);
      sub = until > now ? 'Go to your check-in spot and take the photo.' : 'Past the deadline. Wrapping up…';
      arrived.textContent = 'Take check-in photo';
    }
    const left = until - now;
    arrived.hidden = left <= 0;
    arrived.className = 'btn btn-large ' + button;

    $('phase-label').textContent = label;
    timer.textContent = mmss(left);
    $('dial').classList.remove('alarm', 'stopped');
    if (mode) $('dial').classList.add(mode);
    $('dial-end').hidden = !ends || left <= 0;
    $('dial-end-time').textContent = ends;
    $('timer-sub').textContent = sub;
    const remaining = Math.min(1, Math.max(0, left / (until - from)));
    $('ring').style.strokeDashoffset = String(RING_LENGTH * (1 - remaining));

    // Time is up on this phone's view: ask the server, which makes the actual call.
    if (left <= 0 && Date.now() - lastOverdueRefresh > 5000) {
      lastOverdueRefresh = Date.now();
      refresh();
    }
  }

  // With more than one spot, ask where the user is. The AI only compares with that spot's photos.
  $('arrived').onclick = () => {
    const spots = usableSpots();
    if (spots.length === 1) return openCamera('checkin', spots[0]);
    const list = $('spot-picks');
    list.replaceChildren();
    for (const spot of spots) {
      const pick = el('button', { type: 'button', className: 'pick' },
        el('img', { src: spot.references[0].url || '', alt: '' }),
        el('span', { className: 'pick-name', textContent: spot.name }),
        el('span', { className: 'pick-meta', textContent: photoCount(spot.references.length) }),
      );
      pick.onclick = () => {
        $('spot-picker').hidden = true;
        openCamera('checkin', spot);
      };
      list.append(el('li', {}, pick));
    }
    $('spot-picker').hidden = false;
  };

  $('spot-picker-cancel').onclick = () => {
    $('spot-picker').hidden = true;
  };
  $('spot-picker').onclick = (ev) => {
    if (ev.target === $('spot-picker')) $('spot-picker').hidden = true;
  };

  // ---------- camera ----------

  let stream = null;
  let camMode = null;
  let camSpot = null; // the spot this photo is for
  let shot = null;
  let ghostUrl = null; // the reference laid over the viewfinder, if any
  let camGuide = false; // whether reference thumbnails are offered in the viewfinder

  async function openCamera(mode, spot) {
    camMode = mode;
    camSpot = spot;
    shot = null;
    ghostUrl = null;
    camGuide = mode === 'checkin' && spot.references.length > 0;
    if (camGuide) renderRefRow($('cam-refs-row'), spot.references, toggleGhost);
    camUi('live');
    $('screen-camera').hidden = false;
    $('cam-msg').textContent =
      mode === 'checkin'
        ? `Checking in at ${spot.name}. Match the angle of a reference photo: tap one at the bottom left to lay it over the view, line it up, then shoot.`
        : `Photo for ${spot.name}. Shoot the fixed scene with no people in it. Pick a distinctive angle with art, furniture or signs. Plain walls and blinds are not enough.`;
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
    $('cam-refs').hidden = !live || !camGuide;
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
        await saveReference(shot, camSpot);
        closeCamera();
      } catch (e) {
        $('cam-msg').textContent = e.message;
        camUi('shot');
      }
      return;
    }

    $('cam-msg').textContent = 'The AI is checking. A few seconds…';
    try {
      const r = await cloud.api('POST', 'photo', { session_id: state.active.id, spot_id: camSpot.id, image: shot.split(',')[1] });
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
    $('spot-picker').hidden = true;
    state = null;
    show('auth');
    $('auth-tabs').hidden = false;
    $('auth-form').hidden = false;
    $('code-form').hidden = true;
    $('reset-form').hidden = true;
    flash('auth-msg', message || '');
  }

  function setAuthMode(mode) {
    authMode = mode;
    $('auth-tabs').dataset.mode = mode;
    for (const b of $('auth-tabs').children) b.classList.toggle('on', b.dataset.mode === mode);
    $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
    $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('forgot').hidden = mode !== 'login';
    flash('auth-msg', '');
  }

  function showCode(email) {
    pendingEmail = email;
    $('code-email').textContent = email;
    $('code-input').value = '';
    $('auth-tabs').hidden = true;
    $('auth-form').hidden = true;
    $('code-form').hidden = false;
  }

  async function afterLogin() {
    $('auth-password').value = '';
    show('loading');
    $('loading-msg').textContent = 'Loading…';
    await refresh();
  }

  for (const b of $('auth-tabs').children) b.onclick = () => setAuthMode(b.dataset.mode);

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
    $('auth-tabs').hidden = true;
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

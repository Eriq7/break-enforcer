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

  const SCREENS = ['loading', 'auth', 'home', 'settings', 'session'];
  function show(name) {
    current = name;
    for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
    $('settings-open').hidden = name !== 'home';
    $('settings-done').hidden = name !== 'settings';
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

  let wantSettings = false; // Settings is open and stays open across refreshes

  function render() {
    if (state.active) {
      const arriving = current !== 'session';
      wantSettings = false;
      $('describe-sheet').hidden = true;
      $('ref-menu').hidden = true;
      renderSession();
      show('session');
      if (arriving) windUpRing();
      startTicker();
    } else {
      stopTicker();
      $('ref-picker').hidden = true;
      renderHome();
      renderSettings();
      show(wantSettings ? 'settings' : 'home');
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
    if (s.status === 'excused') return ['Not counted', ''];
    return [s.fail_reason === 'no_pass' ? 'Photo failed' : 'No photo', 'tag-fail'];
  }

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

  // Just the dial and the start button. Everything else lives in Settings.
  function renderHome() {
    renderStartLabel();
    $('hero-time').textContent = mmss(state.timing.relax * 1000);
    $('hero-sub').textContent = `then ${duration(state.timing.buffer)} to check in`;
    const hasRefs = state.references.length > 0;
    $('start').disabled = !hasRefs || !state.card;
    $('start-hint').textContent = !hasRefs
      ? 'Add a check-in photo in Settings first.'
      : !state.card
        ? 'Add a card in Settings first.'
        : "Can't be cancelled once started.";
    $('start-setup').hidden = hasRefs && !!state.card;
  }

  function openSettings() {
    wantSettings = true;
    show('settings');
    window.scrollTo(0, 0);
  }

  $('settings-open').onclick = openSettings;
  $('start-setup').onclick = openSettings;
  $('settings-done').onclick = () => {
    wantSettings = false;
    show('home');
    window.scrollTo(0, 0);
  };

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

  // ---------- settings ----------

  function renderSettings() {
    renderRefs();
    renderCard();
    renderTelegram();
    renderLast();
    renderHistory();
    watchBilling();
  }

  // The latest break: how it went, and what it cost.
  function renderLast() {
    const latest = state.latest;
    $('last').hidden = !latest;
    if (!latest) return;
    const passed = latest.status === 'passed';
    const excused = latest.status === 'excused';
    $('last-status').textContent = passed ? 'Last break passed' : excused ? "Last break doesn't count" : 'Last break failed';
    $('last').className = 'last ' + (passed ? 'pass' : excused ? 'excused' : 'fail');
    const lastAttempt = state.attempts[state.attempts.length - 1];
    let detail;
    if (passed) {
      detail = `First photo at ${clock(latest.first_photo_at, true)}. The deadline was ${clock(latest.deadline_at, true)}.`;
    } else if (excused) {
      detail = "The AI check wasn't working when you checked in, so this break doesn't count against you.";
    } else if (latest.fail_reason === 'no_photo') {
      detail = `No photo before ${clock(latest.deadline_at, true)}.`;
    } else {
      detail = 'No photo passed the check.' + (lastAttempt?.reason ? ` Last one: ${lastAttempt.reason}` : '');
    }
    if (!passed && !excused) detail += ' ' + billingLine(latest);
    $('last-detail').textContent = detail;
  }

  function renderHistory() {
    const history = $('history');
    history.replaceChildren();
    if (state.history.length === 0) history.append(el('li', {}, el('span', { className: 'dim', textContent: 'Nothing yet' })));
    for (const s of state.history) {
      const [text, cls] = sessionTag(s);
      history.append(el('li', {}, el('span', { className: 'when', textContent: day(s.started_at) }), el('span', { className: cls, textContent: text })));
    }
  }

  // ---------- check-in photos ----------

  const photosFull = () => state.references.length >= state.max_references;

  // Each photo with its description underneath and a ⋯ button for the rest.
  function renderRefs() {
    const box = $('refs');
    box.replaceChildren();
    if (state.references.length === 0) {
      box.append(el('div', { className: 'refs-empty', textContent: 'No photos yet' }));
    }
    for (const r of state.references) {
      const open = el('button', { type: 'button', className: 'ref-open', title: 'View photo' }, el('img', { src: r.url || '', alt: r.description, loading: 'lazy' }));
      open.onclick = () => peek(r.url);
      const more = el('button', { type: 'button', className: 'ref-more', title: 'More' }, dotsIcon());
      more.setAttribute('aria-label', 'More options for ' + r.description);
      more.onclick = () => openRefMenu(r);
      box.append(el('div', { className: 'ref' }, open, more, el('span', { className: 'ref-caption', textContent: r.description })));
    }
    const full = photosFull();
    $('ref-camera').disabled = full;
    $('ref-file').disabled = full;
    $('ref-file-label').classList.toggle('disabled', full);
  }

  function dotsIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const cx of [5.5, 12, 18.5]) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', 12);
      dot.setAttribute('r', 2);
      svg.append(dot);
    }
    return svg;
  }

  function peek(url) {
    if (!url) return;
    $('peek-img').src = url;
    $('peek').hidden = false;
  }

  $('ref-camera').onclick = () => openCamera('reference');

  // Picking from the album is fine for a reference; check-ins only ever use the live camera.
  $('ref-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    flash('refs-msg', '');
    try {
      openDescribe({ image: await fileToJpeg(file) });
    } catch (e) {
      flash('refs-msg', e.message);
    }
  };

  // The ⋯ menu of one photo.
  let menuRef = null;

  function openRefMenu(ref) {
    menuRef = ref;
    $('ref-menu-title').textContent = ref.description;
    $('ref-menu-delete').classList.remove('armed');
    $('ref-menu-delete').textContent = 'Delete photo';
    flash('ref-menu-msg', '');
    $('ref-menu').hidden = false;
  }

  function closeRefMenu() {
    $('ref-menu').hidden = true;
    menuRef = null;
  }

  $('ref-menu-cancel').onclick = closeRefMenu;
  $('ref-menu').onclick = (ev) => {
    if (ev.target === $('ref-menu')) closeRefMenu();
  };
  $('ref-menu-view').onclick = () => {
    const ref = menuRef;
    closeRefMenu();
    peek(ref.url);
  };
  $('ref-menu-edit').onclick = () => {
    const ref = menuRef;
    closeRefMenu();
    openDescribe({ ref });
  };
  $('ref-menu-delete').onclick = async () => {
    const button = $('ref-menu-delete');
    if (!confirmed(button, 'Tap again to delete')) return;
    button.disabled = true;
    try {
      await cloud.api('DELETE', 'references?id=' + encodeURIComponent(menuRef.id));
      closeRefMenu();
      await refresh();
      flash('refs-msg', 'Photo deleted', true);
    } catch (e) {
      flash('ref-menu-msg', e.message);
    } finally {
      button.disabled = false;
    }
  };

  // Saying where a photo is: right after taking or choosing a new one ({ image }: its JPEG data
  // URL, not saved until this goes through), or changing an existing one ({ ref }).
  let describing = null;

  function openDescribe(job) {
    describing = job;
    $('describe-title').textContent = job.ref ? 'Edit description' : 'Where is this?';
    $('describe-preview').src = job.ref ? job.ref.url || '' : job.image;
    $('describe-input').value = job.ref ? job.ref.description : '';
    flash('describe-msg', '');
    $('describe-sheet').hidden = false;
  }

  function closeDescribe() {
    $('describe-sheet').hidden = true;
    describing = null;
  }

  $('describe-cancel').onclick = closeDescribe;

  $('describe-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const job = describing;
    if (!job) return;
    const description = $('describe-input').value.trim();
    if (!description) return flash('describe-msg', 'Say where this is, like "7th floor room"');
    $('describe-save').disabled = true;
    flash('describe-msg', 'Saving…', true);
    try {
      if (job.ref) await cloud.api('PATCH', 'references', { id: job.ref.id, description });
      else await cloud.api('POST', 'references', { image: job.image.split(',')[1], description });
      closeDescribe();
      await refresh();
      flash('refs-msg', job.ref ? 'Description saved' : 'Photo saved', true);
    } catch (e) {
      flash('describe-msg', e.message);
    } finally {
      $('describe-save').disabled = false;
    }
  };

  // ---------- card ----------

  const money = (cents) => '$' + (cents / 100).toFixed(2);
  // "Nov 2, 15:30"
  const dateTime = (value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + clock(value);
  const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay', diners: 'Diners' };

  // What a failed break cost, or why it cost nothing.
  function billingLine(s) {
    if (!s.billing_mode) return "Payments weren't connected yet, so nothing was charged.";
    const hold = state.charges.find((c) => c.kind === 'hold');
    const fee = state.charges.find((c) => c.kind === 'fee');
    if (s.billing_status === 'charged' && hold && fee) {
      return hold.status === 'voided'
        ? `Charged the ${money(fee.amount)} fee. The ${money(hold.amount)} hold was released on ${dateTime(hold.voided_at)}.`
        : `Charged a ${money(fee.amount)} fee and put ${money(hold.amount)} on hold, released on ${dateTime(hold.void_due_at)}.`;
    }
    if (s.billing_status === 'declined' || s.billing_status === 'error') return s.billing_note || 'Nothing was charged.';
    return 'Charging your card…';
  }

  // A failed break is charged within a minute or two. Check back until it's done.
  let billingCheck = null;
  function watchBilling() {
    if (state.latest?.billing_status !== 'due' || billingCheck) return;
    billingCheck = setTimeout(() => {
      billingCheck = null;
      refresh();
    }, 5000);
  }

  function renderCard() {
    const c = state.card;
    $('card-label').textContent = c ? `${BRANDS[c.brand] || 'Card'} ${c.funding === 'debit' ? 'debit ' : ''}•••• ${c.last4}` : 'No card yet';
    $('card-label').className = c ? '' : 'dim';
    $('card-edit').textContent = c ? 'Change' : 'Add';
    $('card-note').textContent = 'A missed check-in costs a $2.25 fee plus a $43 hold, released in 5 days.';
  }

  let stripeJs = null; // Stripe's script, loaded the first time a card is added
  let cardForm = null; // { stripe, elements } while the card sheet is open

  function loadStripe() {
    if (!stripeJs) {
      stripeJs = new Promise((resolve, reject) => {
        const script = el('script', { src: 'https://js.stripe.com/v3/' });
        script.onload = () => resolve(window.Stripe);
        script.onerror = () => {
          stripeJs = null;
          script.remove();
          reject(offline());
        };
        document.head.append(script);
      });
    }
    return stripeJs;
  }

  // Stripe's own card form, in a sheet. The card number goes straight to Stripe, never to our server.
  $('card-edit').onclick = async () => {
    $('card-edit').disabled = true;
    flash('card-msg', '');
    try {
      const [Stripe, r] = await Promise.all([loadStripe(), cloud.api('POST', 'card')]);
      const stripe = Stripe(r.publishable_key);
      const elements = stripe.elements({
        clientSecret: r.client_secret,
        appearance: { theme: 'night', variables: { colorPrimary: '#FF9F0A', colorBackground: '#2C2C2E', borderRadius: '10px' } },
      });
      $('card-form').replaceChildren();
      elements.create('payment', { wallets: { applePay: 'never', googlePay: 'never' } }).mount($('card-form'));
      cardForm = { stripe, elements };
      $('card-sheet-title').textContent = state.card ? 'Change card' : 'Add a card';
      flash('card-sheet-msg', '');
      $('card-sheet').hidden = false;
    } catch (e) {
      flash('card-msg', e.message);
    } finally {
      $('card-edit').disabled = false;
    }
  };

  function closeCardSheet() {
    $('card-sheet').hidden = true;
    $('card-form').replaceChildren();
    cardForm = null;
  }

  $('card-cancel').onclick = closeCardSheet;

  $('card-save').onclick = async () => {
    if (!cardForm) return;
    $('card-save').disabled = true;
    flash('card-sheet-msg', '');
    try {
      const { error, setupIntent } = await cardForm.stripe.confirmSetup({ elements: cardForm.elements, redirect: 'if_required' });
      if (error) throw new Error(error.message);
      await cloud.api('PUT', 'card', { setup_intent_id: setupIntent.id });
      closeCardSheet();
      await refresh();
      flash('card-msg', 'Card saved', true);
    } catch (e) {
      flash('card-sheet-msg', e.message);
    } finally {
      $('card-save').disabled = false;
    }
  };

  // ---------- Telegram reminder ----------

  let tgOpening = false; // sent the user off to tap Start in Telegram

  function renderTelegram() {
    $('tg-connect').textContent = state.telegram ? 'Reconnect' : 'Connect';
    $('tg-note').textContent = state.telegram ? 'Connected. Messages at 40:00 and 45:25.' : 'Messages at 40:00 and 45:25. Connect once.';
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
      const where = state.references.length > 1 ? state.references.find((r) => r.id === last.reference_id)?.description : null;
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
    renderRefRow($('session-refs-row'), state.references, (ref) => peek(ref.url));
    $('session-refs').hidden = state.references.length === 0;
    flash('session-msg', '');
    tick();
  }

  // One button per reference photo, used on the session screen and inside the camera.
  function renderRefRow(row, refs, onPick) {
    row.replaceChildren();
    for (const ref of refs) {
      const button = el('button', { type: 'button', title: ref.description }, el('img', { src: ref.url || '', alt: ref.description }));
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

  // With more than one photo, ask which one the user is standing at. The AI compares with that one only.
  $('arrived').onclick = () => {
    const refs = state.references;
    if (refs.length === 1) return openCamera('checkin', refs[0]);
    const list = $('ref-picks');
    list.replaceChildren();
    for (const ref of refs) {
      const pick = el('button', { type: 'button', className: 'pick' },
        el('img', { src: ref.url || '', alt: '' }),
        el('span', { className: 'pick-name', textContent: ref.description }),
      );
      pick.onclick = () => {
        $('ref-picker').hidden = true;
        openCamera('checkin', ref);
      };
      list.append(el('li', {}, pick));
    }
    $('ref-picker').hidden = false;
  };

  $('ref-picker-cancel').onclick = () => {
    $('ref-picker').hidden = true;
  };
  $('ref-picker').onclick = (ev) => {
    if (ev.target === $('ref-picker')) $('ref-picker').hidden = true;
  };

  // ---------- camera ----------

  let stream = null;
  let camMode = null;
  let camRef = null; // the photo a check-in is matched against
  let shot = null;
  let ghostUrl = null; // the reference laid over the viewfinder, if any
  let camGuide = false; // whether reference thumbnails are offered in the viewfinder

  async function openCamera(mode, ref = null) {
    camMode = mode;
    camRef = ref;
    shot = null;
    // A check-in starts with the picked photo laid over the view, to line up the same shot.
    ghostUrl = mode === 'checkin' ? ref.url || null : null;
    camGuide = !!ghostUrl;
    if (camGuide) {
      $('ghost').src = ghostUrl;
      renderRefRow($('cam-refs-row'), [ref], toggleGhost);
      $('cam-refs-row').firstChild.classList.add('on');
    }
    camUi('live');
    $('screen-camera').hidden = false;
    $('cam-msg').textContent =
      mode === 'checkin'
        ? `${ref.description}: line up the faded photo, then shoot.`
        : 'Pick an angle with art, furniture or signs in it. No people.';
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
    if (camMode === 'reference') {
      const image = shot;
      closeCamera();
      openDescribe({ image });
      return;
    }
    camUi('busy');

    $('cam-msg').textContent = 'The AI is checking. A few seconds…';
    try {
      const r = await cloud.api('POST', 'photo', { session_id: state.active.id, reference_id: camRef.id, image: shot.split(',')[1] });
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
    closeCardSheet();
    closeDescribe();
    closeRefMenu();
    $('ref-picker').hidden = true;
    wantSettings = false;
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

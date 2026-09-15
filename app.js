// Pomi moderasyon paneli — bağımlılık yalnız supabase-js (index.html, SRI'lı).
//
// Güvenlik modeli: bu dosya da publishable anahtar da herkese açık; YETKİ
// TAMAMEN SUNUCUDA. Her admin RPC'si `assert_app_admin()` ile başlar
// (app_admins tablosunda olmak + 2FA ile doğrulanmış aal2 oturum). Buradaki
// kontroller yalnız doğru ekranı göstermek için; atlatılsa bile veri gelmez.
//
// Kullanıcı içeriği DOM'a yalnız textContent ile girer (innerHTML yok).
'use strict';

(() => {
  // Başka bir sitenin çerçevesinde açılmasın (tıklama tuzağı). GitHub Pages
  // başlık gönderemediği, meta CSP de frame-ancestors'ı desteklemediği için.
  if (window.top !== window.self) {
    document.documentElement.replaceChildren();
    return;
  }

  const SUPABASE_URL = 'https://ndkewpwpojjhqbeqtzth.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_zpkHOczlxtbGDsfnxtlncg_qr7Cic8F';
  const STORAGE_KEY = 'pomi-admin-auth';
  const NOTICE_KEY = 'pomi-admin-notice';
  const IDLE_LIMIT_MS = 30 * 60 * 1000;
  const IDLE_NOTICE = '30 dakika işlem yapılmadığı için oturum kapatıldı.';
  // Mağaza beklentisi: şikayete 24 saat içinde işlem.
  const SLA_HOURS = 24;
  const SLA_WARN_HOURS = 12;
  const SLA_DANGER_HOURS = 20;
  const BASE_TITLE = 'Pomi Moderasyon';

  const app = document.getElementById('app');
  const sessionBox = document.getElementById('session');
  const toastBox = document.getElementById('toast');
  const dialog = document.getElementById('dialog');

  const REASONS = {
    spam: 'Spam / reklam',
    abuse: 'Taciz / zorbalık',
    inappropriate: 'Uygunsuz içerik',
    other: 'Diğer',
  };
  const REMOVED = {
    author: 'gönderen sildi',
    owner: 'oda kurucusu kaldırdı',
    reports: '3 şikayetle otomatik gizlendi',
    admin: 'admin kaldırdı',
  };
  const RESOLUTIONS = {
    dismissed: 'İhlal yok',
    removed: 'Mesaj kaldırıldı',
    banned: 'Gönderen yasaklandı',
  };
  const ACTIONS = {
    reports_dismiss: 'Şikayet kapatıldı: ihlal yok',
    reports_remove: 'Mesaj kaldırıldı',
    ban: 'Yasaklandı',
    unban: 'Yasak kaldırıldı',
  };
  const BAN_DURATIONS = [
    ['24', '24 saat'],
    ['168', '7 gün'],
    ['720', '30 gün'],
    ['permanent', 'Kalıcı'],
  ];
  const BAN_REASON_PRESETS = [
    'Taciz / zorbalık içeren mesaj.',
    'Spam ya da reklam paylaşımı.',
    'Uygunsuz içerik paylaşımı.',
  ];

  // Sunucu hata anahtarı / Supabase Auth mesajı → kullanıcı metni.
  const ERRORS = [
    ['invalid login credentials', 'E-posta ya da şifre hatalı.'],
    ['email not confirmed', 'E-posta adresi doğrulanmamış.'],
    ['invalid totp code', 'Kod hatalı ya da süresi geçti. Uygulamadaki güncel kodu gir.'],
    ['rate limit', 'Çok fazla deneme. Biraz bekleyip tekrar dene.'],
    ['too many', 'Çok fazla deneme. Biraz bekleyip tekrar dene.'],
    ['admin_required', 'Bu hesabın admin yetkisi yok.'],
    ['mfa_required', 'İki adımlı doğrulama gerekli.'],
    ['cannot_ban_admin', 'Bir admin yasaklanamaz.'],
    ['invalid_duration', 'Süre 1 saat ile 366 gün arasında olmalı.'],
    ['reason_required', 'Gerekçe zorunlu.'],
    ['user_not_found', 'Kullanıcı bulunamadı (hesap silinmiş olabilir).'],
    ['query_too_short', 'En az 2 karakter yaz.'],
    ['no_reports', 'İşlem yapılacak şikayet yok.'],
    ['failed to fetch', 'Bağlantı kurulamadı. İnternetini kontrol et.'],
    ['networkerror', 'Bağlantı kurulamadı. İnternetini kontrol et.'],
  ];

  /** Kullanıcıya olduğu gibi gösterilecek doğrulama hatası. */
  class UserError extends Error {}

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    app.replaceChildren(
      h('p', { class: 'form-error', text: 'Supabase kitaplığı yüklenemedi. Sayfayı yenile.' }),
    );
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      // Sekme kapanınca oturum biter: paylaşılan bir bilgisayarda yenileme
      // jetonu localStorage'da kalmasın.
      storage: window.sessionStorage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  const state = {
    email: '',
    tab: 'reports',
    reportStatus: 'open',
    revealed: new Set(),
    reportsLoadedAt: 0,
    userQuery: '',
  };
  let shellMounted = false;
  // Sekme değişince eski isteğin sonucu yeni görünümü ezmesin.
  let viewToken = 0;

  // ─── DOM yardımcıları ─────────────────────────────────────────────────────

  /**
   * Eleman üretir. Metin yalnız `text` ya da çocuk dizesi olarak girer
   * (textContent / Text düğümü) — kullanıcı içeriği asla HTML yorumlanmaz.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function button(label, onClick, tone = 'ghost', extra = {}) {
    return h('button', { type: 'button', class: `btn btn-${tone}`, text: label, onclick: onClick, ...extra });
  }

  function setBusy(btn, busy, busyText = 'İşleniyor…') {
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyText;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    } else {
      btn.textContent = btn.dataset.label ?? btn.textContent;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }

  function showError(el, message) {
    el.textContent = message ?? '';
    el.hidden = !message;
  }

  function errorText(err) {
    if (err instanceof UserError) return err.message;
    const raw = String(err?.message ?? err ?? '');
    const lower = raw.toLowerCase();
    const hit = ERRORS.find(([key]) => lower.includes(key));
    return hit ? hit[1] : `Beklenmeyen hata: ${raw.slice(0, 160) || 'bilinmiyor'}`;
  }

  let toastTimer = 0;
  function toast(message, tone = 'ok') {
    toastBox.textContent = message;
    toastBox.dataset.tone = tone;
    toastBox.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastBox.hidden = true; }, tone === 'error' ? 7000 : 3500);
  }

  function emptyState(text) {
    return h('p', { class: 'empty', text });
  }

  function errorState(err, retry) {
    return h('div', { class: 'card error-card', role: 'alert' },
      h('p', { text: errorText(err) }),
      button('Tekrar dene', retry));
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} kopyalandı`);
    } catch {
      toast('Kopyalanamadı', 'error');
    }
  }

  // ─── Zaman ────────────────────────────────────────────────────────────────

  const fullDate = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  const shortTime = new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  function toDate(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  }

  function formatDate(iso) {
    const d = toDate(iso);
    return d ? fullDate.format(d) : '—';
  }

  function formatShort(iso) {
    const d = toDate(iso);
    return d ? shortTime.format(d) : '—';
  }

  function formatSpan(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes} dk`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return minutes % 60 ? `${hours} sa ${minutes % 60} dk` : `${hours} sa`;
    return `${Math.floor(hours / 24)} gün`;
  }

  function ago(iso) {
    const d = toDate(iso);
    if (!d) return '';
    const ms = Date.now() - d.getTime();
    return ms < 60000 ? 'az önce' : `${formatSpan(ms)} önce`;
  }

  function durationLabel(hours) {
    if (hours === null || hours === undefined) return 'Kalıcı';
    return hours % 24 === 0 ? `${hours / 24} gün` : `${hours} saat`;
  }

  // ─── Oturum ───────────────────────────────────────────────────────────────

  function setNotice(text) {
    try { sessionStorage.setItem(NOTICE_KEY, text); } catch { /* gizli mod */ }
  }

  function takeNotice() {
    try {
      const text = sessionStorage.getItem(NOTICE_KEY);
      sessionStorage.removeItem(NOTICE_KEY);
      return text;
    } catch {
      return null;
    }
  }

  let lastActivity = Date.now();
  let idleTimer = 0;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true });
  }

  function startIdleWatch() {
    stopIdleWatch();
    lastActivity = Date.now();
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity >= IDLE_LIMIT_MS) signOut(IDLE_NOTICE);
    }, 30000);
  }

  function stopIdleWatch() {
    clearInterval(idleTimer);
    idleTimer = 0;
  }

  async function signOut(notice) {
    stopIdleWatch();
    if (notice) setNotice(notice);
    const { error } = await sb.auth.signOut();
    if (error) {
      // Ağ yoksa istemci oturumu silmez; bu cihazda yine de bitir.
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* gizli mod */ }
      location.reload();
    }
    // Başarılıysa SIGNED_OUT olayı giriş ekranını çizer.
  }

  sb.auth.onAuthStateChange((event) => {
    // Geri çağırım içinde başka auth çağrısı beklemek kilitlenir; sıraya al.
    if (event === 'SIGNED_OUT') setTimeout(renderLogin, 0);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !shellMounted) return;
    if (Date.now() - lastActivity >= IDLE_LIMIT_MS) {
      signOut(IDLE_NOTICE);
      return;
    }
    if (state.tab === 'reports' && !dialog.open && Date.now() - state.reportsLoadedAt > 60000) {
      loadReports();
    }
  });

  /** RPC çağrısı; yetki kaybında (admin çıkarıldı, 2FA düştü) girişe döner. */
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      const message = String(error.message ?? '');
      if (message.includes('admin_required') || message.includes('mfa_required')) {
        setTimeout(boot, 0);
      }
      throw error;
    }
    return data ?? [];
  }

  // ─── Akış: oturum → admin mi → 2FA → panel ────────────────────────────────

  let booting = null;
  function boot() {
    booting ??= runBoot()
      .catch((err) => renderFatal(err))
      .finally(() => { booting = null; });
    return booting;
  }

  async function runBoot() {
    renderLoading();
    const { data: sessionData } = await sb.auth.getSession();
    const session = sessionData?.session;
    if (!session) {
      renderLogin();
      return;
    }
    state.email = session.user?.email ?? '';

    const { data: rows, error } = await sb.rpc('admin_whoami');
    if (error) throw error;
    const who = Array.isArray(rows) ? rows[0] : rows;
    if (!who?.is_admin) {
      await signOut('Bu hesabın admin yetkisi yok. Yetki yalnız Supabase SQL editöründen verilir.');
      return;
    }

    const { data: aal, error: aalError } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) throw aalError;
    if (aal?.currentLevel !== 'aal2') {
      await renderMfa();
      return;
    }
    renderShell();
  }

  function setPage(...nodes) {
    shellMounted = false;
    viewToken++;
    app.replaceChildren(...nodes);
  }

  function renderSessionBar(signedIn) {
    if (!signedIn) {
      sessionBox.replaceChildren();
      return;
    }
    sessionBox.replaceChildren(
      h('span', { class: 'session-email', text: state.email }),
      button('Çıkış', () => signOut(), 'ghost', { class: 'btn btn-ghost btn-small' }),
    );
  }

  function renderLoading(text = 'Yükleniyor…') {
    setPage(h('p', { class: 'muted center', text }));
  }

  function renderFatal(err) {
    renderSessionBar(Boolean(state.email));
    setPage(h('section', { class: 'narrow' }, errorState(err, boot)));
  }

  function renderLogin() {
    stopIdleWatch();
    if (dialog.open) dialog.close();
    state.email = '';
    renderSessionBar(false);
    document.title = BASE_TITLE;
    const notice = takeNotice();

    const email = h('input', {
      id: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', required: true,
    });
    const password = h('input', {
      id: 'password', type: 'password', autocomplete: 'current-password', required: true,
    });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Giriş yap' });

    const form = h('form', { class: 'card stack' },
      h('div', { class: 'field' }, h('label', { for: 'email', text: 'E-posta' }), email),
      h('div', { class: 'field' }, h('label', { for: 'password', text: 'Şifre' }), password),
      error,
      submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError(error, null);
      setBusy(submit, true, 'Giriş yapılıyor…');
      const { error: authError } = await sb.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });
      password.value = '';
      if (authError) {
        setBusy(submit, false);
        showError(error, errorText(authError));
        password.focus();
        return;
      }
      boot();
    });

    setPage(h('section', { class: 'narrow' },
      h('h1', { text: 'Moderasyon paneli' }),
      notice ? h('p', { class: 'notice', role: 'status', text: notice }) : null,
      form,
      h('p', {
        class: 'muted small',
        text: 'Yalnız yetkili hesaplar. Girişten sonra iki adımlı doğrulama zorunludur; '
          + 'oturum sekme kapanınca ya da 30 dakika işlem yapılmayınca biter.',
      })));
    email.focus();
  }

  async function renderMfa() {
    renderSessionBar(true);
    renderLoading('İki adımlı doğrulama hazırlanıyor…');
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw error;
    const totp = (data?.all ?? []).filter((f) => f.factor_type === 'totp');
    const verified = totp.find((f) => f.status === 'verified');
    if (verified) {
      renderChallenge(verified);
      return;
    }

    // Yarım kalmış kurulumlar (QR gösterildi ama kod girilmedi) temizlenir;
    // yoksa yeni kayıt reddedilebilir ve eski gizli anahtar ortada kalır.
    for (const factor of totp) {
      await sb.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data: enrolled, error: enrollError } = await sb.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `pomi-admin-${Date.now().toString(36)}`,
      issuer: 'Pomi Admin',
    });
    if (enrollError) throw enrollError;
    renderEnroll(enrolled);
  }

  function codeForm(submitText, onCode) {
    const input = h('input', {
      id: 'otp', class: 'otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '6', required: true, 'aria-describedby': 'otp-help',
    });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: submitText });
    const form = h('form', { class: 'stack' },
      h('div', { class: 'field' },
        h('label', { for: 'otp', text: 'Doğrulama kodu' }),
        input,
        h('p', { id: 'otp-help', class: 'help', text: 'Doğrulayıcı uygulamasındaki 6 haneli kod.' })),
      error,
      submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) {
        showError(error, '6 haneli kodu gir.');
        input.focus();
        return;
      }
      showError(error, null);
      setBusy(submit, true, 'Doğrulanıyor…');
      try {
        await onCode(code);
      } catch (err) {
        setBusy(submit, false);
        showError(error, errorText(err));
        input.select();
      }
    });
    return { form, input };
  }

  async function verifyAndEnter(factorId, code) {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw error;
    await boot();
  }

  function renderChallenge(factor) {
    const { form, input } = codeForm('Doğrula', (code) => verifyAndEnter(factor.id, code));
    setPage(h('section', { class: 'narrow' },
      h('h1', { text: 'İki adımlı doğrulama' }),
      h('div', { class: 'card stack' }, form),
      h('p', {
        class: 'muted small',
        text: 'Telefonuna erişimin yoksa: Supabase panosu → Authentication → Users → hesabın → '
          + 'MFA faktörünü sil. Sonraki girişte yeni kurulum açılır.',
      })));
    input.focus();
  }

  function renderEnroll(enrolled) {
    const raw = enrolled?.totp?.qr_code ?? '';
    // supabase-js çıplak SVG'nin başına kodlamadan `data:...;utf-8,` ekliyor;
    // SVG'deki `#` ya da `"` adresi bozabilir → yeniden kodla.
    const svg = raw.replace(/^data:image\/svg\+xml;(charset=)?utf-8,/, '');
    const qrSrc = svg.startsWith('<')
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      : raw;
    const secret = enrolled?.totp?.secret ?? '';
    const { form, input } = codeForm('Kurulumu tamamla', (code) => verifyAndEnter(enrolled.id, code));

    setPage(h('section', { class: 'narrow' },
      h('h1', { text: 'İki adımlı doğrulamayı kur' }),
      h('p', {
        class: 'muted',
        text: 'Admin işlemleri yalnız 2FA ile doğrulanmış oturuma açık. Bir kez kurman yeterli.',
      }),
      h('div', { class: 'card stack' },
        h('ol', { class: 'steps' },
          h('li', { text: 'Google Authenticator, 1Password, Authy gibi bir doğrulayıcı uygulamasıyla QR kodu tara.' }),
          h('li', { text: 'Tarayamıyorsan anahtarı elle gir.' }),
          h('li', { text: 'Uygulamanın gösterdiği 6 haneli kodu aşağıya yaz.' })),
        h('img', {
          class: 'qr', src: qrSrc, width: '200', height: '200',
          alt: 'Doğrulayıcı uygulaması için QR kodu',
        }),
        h('div', { class: 'secret' },
          h('code', { text: secret.replace(/(.{4})/g, '$1 ').trim() }),
          button('Anahtarı kopyala', () => copyText(secret, 'Anahtar'), 'ghost', { class: 'btn btn-ghost btn-small' })),
        form),
      h('p', {
        class: 'muted small',
        text: 'Anahtarı kimseyle paylaşma; ekran görüntüsünü saklama.',
      })));
    input.focus();
  }

  // ─── Panel iskeleti ───────────────────────────────────────────────────────

  const TABS = [
    ['reports', 'Şikayetler'],
    ['bans', 'Yasaklılar'],
    ['users', 'Kullanıcılar'],
    ['log', 'İşlem kaydı'],
  ];
  const VIEWS = {
    reports: () => loadReports(),
    bans: () => loadBans(),
    users: () => renderUsers(),
    log: () => loadLog(),
  };

  function renderShell() {
    renderSessionBar(true);
    const nav = h('nav', { class: 'tabs', 'aria-label': 'Bölümler' },
      TABS.map(([id, label]) => h('a', { href: `#${id}`, class: 'tab', id: `tab-${id}` },
        label,
        id === 'reports' ? h('span', { class: 'count', id: 'open-count', hidden: true }) : null)));
    setPage(nav, h('div', { id: 'view', class: 'view' }));
    shellMounted = true;
    startIdleWatch();
    route();
    if (!(state.tab === 'reports' && state.reportStatus === 'open')) refreshOpenCount();
  }

  window.addEventListener('hashchange', () => {
    if (shellMounted) route();
  });

  function route() {
    const hash = location.hash.slice(1);
    state.tab = VIEWS[hash] ? hash : 'reports';
    for (const [id] of TABS) {
      document.getElementById(`tab-${id}`)?.setAttribute('aria-current', id === state.tab ? 'page' : 'false');
    }
    VIEWS[state.tab]();
  }

  function view() {
    return document.getElementById('view');
  }

  function setOpenCount(count) {
    const badge = document.getElementById('open-count');
    if (badge) {
      badge.textContent = String(count);
      badge.setAttribute('aria-label', `${count} açık vaka`);
      badge.hidden = count === 0;
    }
    document.title = count ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }

  async function refreshOpenCount() {
    try {
      const rows = await rpc('admin_list_reports', { p_status: 'open', p_limit: 500 });
      setOpenCount(rows.length);
    } catch {
      // Sayaç kritik değil; liste kendi hatasını gösterir.
    }
  }

  /** Bir işlemden sonra: görünümü yenile, açık vaka sayacını güncelle. */
  function afterMutation() {
    route();
    if (!(state.tab === 'reports' && state.reportStatus === 'open')) refreshOpenCount();
  }

  function viewHeader(title, ...tools) {
    return h('div', { class: 'toolbar' }, h('h1', { text: title }), h('span', { class: 'spacer' }), tools);
  }

  // ─── Şikayetler ───────────────────────────────────────────────────────────

  async function loadReports() {
    const token = ++viewToken;
    const statuses = [['open', 'Açık'], ['resolved', 'Çözülen'], ['all', 'Tümü']];
    const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Durum' },
      statuses.map(([id, label]) => h('button', {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(state.reportStatus === id),
        text: label,
        onclick: () => {
          if (state.reportStatus === id) return;
          state.reportStatus = id;
          loadReports();
        },
      })));
    const list = h('div', { class: 'list', 'aria-busy': 'true' }, h('p', { class: 'muted', text: 'Yükleniyor…' }));
    view().replaceChildren(
      viewHeader('Şikayetler', segmented, button('Yenile', () => loadReports())),
      h('p', {
        class: 'muted small',
        text: 'Aynı mesaja gelen şikayetler tek vakada toplanır. Açıklar en eskiden yeniye; '
          + 'mağaza kuralı gereği 24 saat içinde işlem yap.',
      }),
      list);

    let rows;
    try {
      rows = await rpc('admin_list_reports', { p_status: state.reportStatus, p_limit: 200 });
    } catch (err) {
      if (token === viewToken) list.replaceChildren(errorState(err, () => loadReports()));
      return;
    }
    if (token !== viewToken) return;
    state.reportsLoadedAt = Date.now();
    if (state.reportStatus === 'open') setOpenCount(rows.length);
    list.removeAttribute('aria-busy');
    list.replaceChildren(...(rows.length
      ? rows.map(caseCard)
      : [emptyState(state.reportStatus === 'open' ? 'Açık şikayet yok. 🎉' : 'Kayıt yok.')]));
  }

  function slaChip(firstIso) {
    const age = Date.now() - (toDate(firstIso)?.getTime() ?? Date.now());
    const ageHours = age / 3600000;
    const left = SLA_HOURS * 3600000 - age;
    const tone = ageHours >= SLA_DANGER_HOURS ? 'danger' : ageHours >= SLA_WARN_HOURS ? 'warn' : 'ok';
    return h('span', {
      class: `chip chip-${tone}`,
      title: 'Mağaza kuralı: şikayetlere 24 saat içinde işlem',
      text: left > 0 ? `${formatSpan(left)} kaldı` : '24 saat aşıldı',
    });
  }

  function metaItem(label, ...value) {
    return h('div', { class: 'meta-item' }, h('dt', { text: label }), h('dd', null, value));
  }

  function banBadge(banned, until) {
    if (!banned) return null;
    return h('span', {
      class: 'chip chip-danger chip-small',
      text: until ? `Yasaklı · ${formatShort(until)}'e dek` : 'Kalıcı yasaklı',
    });
  }

  function contentBlock(row) {
    const key = row.case_key;
    const hasText = typeof row.body_snapshot === 'string' && row.body_snapshot.length > 0;
    const body = h('p', { class: 'content-body', text: hasText ? row.body_snapshot : 'İçerik kaydı yok.' });
    const wrap = h('div', { class: 'content' }, body);
    if (!hasText) return wrap;

    // İçerik varsayılan bulanık: panelde gezinirken istemeden okunmasın.
    const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-small content-toggle' });
    const apply = (shown) => {
      wrap.classList.toggle('is-revealed', shown);
      body.setAttribute('aria-hidden', String(!shown));
      toggle.setAttribute('aria-expanded', String(shown));
      toggle.textContent = shown ? 'Gizle' : 'İçeriği göster';
    };
    toggle.addEventListener('click', () => {
      const shown = !state.revealed.has(key);
      if (shown) state.revealed.add(key);
      else state.revealed.delete(key);
      apply(shown);
    });
    apply(state.revealed.has(key));
    wrap.append(toggle);
    return wrap;
  }

  function messageStatus(row) {
    if (!row.message_id) return 'Mesaj 30 günlük saklama süresi dolduğu için silinmiş.';
    if (row.message_removed_at) {
      return `Mesaj yayında değil: ${REMOVED[row.message_removed_reason] ?? 'kaldırıldı'} `
        + `(${formatShort(row.message_removed_at)}).`;
    }
    return 'Mesaj şu an yayında.';
  }

  function caseCard(row) {
    const open = row.open_count > 0;
    const live = Boolean(row.message_id) && !row.message_removed_at;

    const head = h('div', { class: 'chips' },
      open
        ? slaChip(row.first_reported_at)
        : h('span', { class: 'chip chip-done', text: RESOLUTIONS[row.resolution] ?? 'Çözüldü' }),
      h('span', { class: 'chip', text: `${row.report_count} şikayet` }),
      (row.reasons ?? []).map((reason) => h('span', { class: 'chip chip-soft', text: REASONS[reason] ?? reason })));

    const meta = h('dl', { class: 'meta' },
      metaItem('Gönderen',
        h('strong', { text: row.sender_name ?? 'Silinmiş hesap' }),
        row.sender_id ? ` · toplam ${row.sender_report_total} şikayet ` : '',
        banBadge(row.sender_banned, row.sender_banned_until)),
      metaItem('Oda', row.room_name ?? 'Silinmiş oda'),
      metaItem('İlk şikayet', `${formatDate(row.first_reported_at)} · ${ago(row.first_reported_at)}`),
      row.report_count > 1 ? metaItem('Son şikayet', formatDate(row.last_reported_at)) : null,
      !open && row.reviewed_at ? metaItem('İncelendi', formatDate(row.reviewed_at)) : null,
      row.admin_note ? metaItem('Not', row.admin_note) : null);

    const actions = h('div', { class: 'actions' });
    if (row.message_id) actions.append(button('Bağlam', () => showContext(row)));
    if (open) actions.append(button('İhlal yok', () => resolveDialog(row, 'dismiss')));
    if (live) {
      actions.append(button('Mesajı kaldır', () => resolveDialog(row, 'remove'), 'warn'));
    } else if (open) {
      actions.append(button('İhlal var, kapat', () => resolveDialog(row, 'remove'), 'warn'));
    }
    if (row.sender_id) {
      actions.append(row.sender_banned
        ? button('Yasağı kaldır', () => unbanDialog(row.sender_id, row.sender_name))
        : button('Yasakla', () => banDialog({
          userId: row.sender_id,
          name: row.sender_name,
          reportIds: open ? row.report_ids : null,
          messageLive: live,
        }), 'danger'));
    }

    return h('article', { class: `card case${open ? ' is-open' : ''}` },
      head,
      contentBlock(row),
      h('p', { class: 'muted small', text: messageStatus(row) }),
      meta,
      actions);
  }

  async function showContext(row) {
    const list = h('ol', { class: 'context', 'aria-busy': 'true' },
      h('li', { class: 'muted', text: 'Yükleniyor…' }));
    openInfoDialog('Mesaj bağlamı', [
      h('p', {
        class: 'muted small',
        text: `${row.room_name ?? 'Oda'} · şikayet edilen mesaj vurgulu. Öncesi ve sonrasındaki mesajlar.`,
      }),
      list,
    ]);

    try {
      const rows = await rpc('admin_message_context', { p_message_id: row.message_id, p_radius: 8 });
      if (!list.isConnected) return;
      list.removeAttribute('aria-busy');
      if (!rows.length) {
        list.replaceChildren(h('li', { class: 'muted', text: 'Mesaj artık yok (30 gün dolmuş olabilir).' }));
        return;
      }
      list.replaceChildren(...rows.map((m) => h('li', { class: `ctx${m.is_target ? ' is-target' : ''}` },
        h('div', { class: 'ctx-meta' },
          h('strong', { text: m.sender_name ?? 'Pomi' }),
          h('time', { datetime: m.created_at, text: formatShort(m.created_at) }),
          m.is_target ? h('span', { class: 'chip chip-warn chip-small', text: 'Şikayet edilen' }) : null,
          !m.is_target && m.report_count
            ? h('span', { class: 'chip chip-small', text: `${m.report_count} şikayet` })
            : null),
        h('p', {
          class: m.is_removed ? 'ctx-body is-removed' : 'ctx-body',
          text: m.is_removed
            ? `(${REMOVED[m.removed_reason] ?? 'kaldırıldı'}${m.is_target ? ' — içerik vaka kartında' : ''})`
            : (m.body ?? ''),
        }))));
      list.querySelector('.is-target')?.scrollIntoView({ block: 'center' });
    } catch (err) {
      if (list.isConnected) list.replaceChildren(h('li', { class: 'form-error', text: errorText(err) }));
    }
  }

  function resolveDialog(row, action) {
    const note = textArea('resolve-note', 'Not (isteğe bağlı)', {
      help: 'Yalnız panelde ve işlem kaydında görünür; kullanıcıya gösterilmez.',
    });
    const dismiss = action === 'dismiss';
    const live = Boolean(row.message_id) && !row.message_removed_at;
    const intro = dismiss
      ? (row.message_removed_at
        ? 'Vaka kapatılır. Otomatik gizlenen mesaj yeniden görünür OLMAZ.'
        : 'Vaka kapatılır, mesaj yayında kalır.')
      : (live
        ? 'Mesaj tüm üyelerden kaldırılır ve açık şikayetler kapatılır. Gönderen yasaklanmaz.'
        : 'Vaka "ihlal var" olarak kapatılır. Mesaj zaten yayında değil.');

    openDialog({
      title: dismiss ? 'İhlal yok' : (live ? 'Mesajı kaldır' : 'İhlal var, kapat'),
      intro,
      fields: [note.wrap],
      confirmText: dismiss ? 'Kapat' : (live ? 'Kaldır' : 'Kapat'),
      tone: dismiss ? 'primary' : 'warn',
      onConfirm: async () => {
        await rpc('admin_resolve_reports', {
          p_report_ids: row.report_ids,
          p_action: action,
          p_note: note.input.value.trim() || null,
        });
        toast(dismiss ? 'Vaka kapatıldı' : (live ? 'Mesaj kaldırıldı' : 'Vaka kapatıldı'));
        afterMutation();
      },
    });
  }

  // ─── Yasak ────────────────────────────────────────────────────────────────

  function banDialog({ userId, name, reportIds, messageLive }) {
    const duration = radioGroup('ban-duration', 'Süre', BAN_DURATIONS, '24');
    const reason = textArea('ban-reason', 'Gerekçe', {
      required: true,
      help: 'Kullanıcı uygulamada bu gerekçeyi görür. Kısa ve hangi kuralın çiğnendiğini söyleyen bir cümle yaz.',
    });
    const presets = h('div', { class: 'presets', role: 'group', 'aria-label': 'Hazır gerekçeler' },
      BAN_REASON_PRESETS.map((text) => h('button', {
        type: 'button',
        class: 'chip chip-button',
        text,
        onclick: () => {
          reason.input.value = text;
          reason.input.focus();
        },
      })));
    const permanentHint = h('p', {
      class: 'help warn-text',
      text: 'Kalıcı yasakta kullanıcı üye olduğu tüm odalardan da çıkarılır.',
      hidden: true,
    });
    duration.el.addEventListener('change', () => {
      permanentHint.hidden = duration.value() !== 'permanent';
    });

    let removeBox = null;
    const fields = [
      h('p', { class: 'muted small', text: 'Kapsam: sohbet, tepki, oda kurma ve odaya katılma kapanır. Sayaç ve bahçe çalışmaya devam eder.' }),
      duration.el,
      permanentHint,
      reason.wrap,
      presets,
    ];
    if (reportIds && messageLive) {
      removeBox = h('input', { type: 'checkbox', id: 'ban-remove' });
      removeBox.checked = true;
      fields.push(h('label', { class: 'check', for: 'ban-remove' },
        removeBox, h('span', { text: 'Şikayet edilen mesajı da kaldır' })));
    }

    openDialog({
      title: `${name ?? 'Kullanıcı'} yasaklansın mı?`,
      fields,
      confirmText: 'Yasakla',
      tone: 'danger',
      onConfirm: async () => {
        const text = reason.input.value.trim();
        if (!text) {
          reason.input.focus();
          throw new UserError('Gerekçe zorunlu — kullanıcıya gösterilir.');
        }
        const choice = duration.value() ?? '24';
        const hours = choice === 'permanent' ? null : Number(choice);
        await rpc('admin_ban_user', {
          p_user_id: userId,
          p_hours: hours,
          p_reason: text,
          p_report_ids: reportIds ?? null,
        });

        // Yasak zaten uygulandı: kaldırma hatası diyaloğu açık tutup
        // tekrar "Yasakla"ya bastırmasın, ayrıca bildirilir.
        if (removeBox?.checked) {
          try {
            await rpc('admin_resolve_reports', { p_report_ids: reportIds, p_action: 'remove', p_note: null });
          } catch (err) {
            toast(`Yasaklandı, ama mesaj kaldırılamadı: ${errorText(err)}`, 'error');
            afterMutation();
            return;
          }
        }
        toast(`${name ?? 'Kullanıcı'} yasaklandı (${durationLabel(hours)})`);
        afterMutation();
      },
    });
  }

  function unbanDialog(userId, name) {
    openDialog({
      title: `${name ?? 'Kullanıcı'} için yasak kaldırılsın mı?`,
      intro: 'Topluluk özellikleri hemen açılır. Kalıcı yasakta çıkarıldığı odalara kendisi yeniden katılabilir.',
      confirmText: 'Yasağı kaldır',
      tone: 'primary',
      onConfirm: async () => {
        await rpc('admin_unban_user', { p_user_id: userId });
        toast('Yasak kaldırıldı');
        afterMutation();
      },
    });
  }

  async function loadBans() {
    const token = ++viewToken;
    const list = h('div', { class: 'list', 'aria-busy': 'true' }, h('p', { class: 'muted', text: 'Yükleniyor…' }));
    view().replaceChildren(viewHeader('Yasaklılar', button('Yenile', () => loadBans())), list);

    let rows;
    try {
      rows = await rpc('admin_list_bans');
    } catch (err) {
      if (token === viewToken) list.replaceChildren(errorState(err, () => loadBans()));
      return;
    }
    if (token !== viewToken) return;
    list.removeAttribute('aria-busy');
    if (!rows.length) {
      list.replaceChildren(emptyState('Yasaklı kullanıcı yok.'));
      return;
    }
    list.replaceChildren(...rows.map((row) => h('article', { class: 'card' },
      h('div', { class: 'chips' },
        h('strong', { class: 'name', text: row.username }),
        row.permanent
          ? h('span', { class: 'chip chip-danger', text: 'Kalıcı' })
          : h('span', {
            class: 'chip chip-warn',
            text: `${formatShort(row.banned_until)}'e dek · ${formatSpan(toDate(row.banned_until).getTime() - Date.now())} kaldı`,
          })),
      h('dl', { class: 'meta' },
        metaItem('Gerekçe', row.ban_reason ?? '—'),
        metaItem('Yasaklandı', formatDate(row.banned_at)),
        metaItem('Toplam şikayet', String(row.report_total))),
      h('div', { class: 'actions' },
        button('Kimliği kopyala', () => copyText(row.user_id, 'Kullanıcı kimliği')),
        button('Yasağı kaldır', () => unbanDialog(row.user_id, row.username), 'primary')))));
  }

  // ─── Kullanıcılar ─────────────────────────────────────────────────────────

  function renderUsers() {
    ++viewToken;
    const input = h('input', {
      id: 'user-query', type: 'search', autocomplete: 'off', spellcheck: 'false', minlength: '2',
      placeholder: 'Kullanıcı adı, tam e-posta ya da kimlik', 'aria-describedby': 'user-query-help',
    });
    input.value = state.userQuery;
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Ara' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const results = h('div', { class: 'list' });
    const form = h('form', { class: 'card stack' },
      h('label', { for: 'user-query', text: 'Kullanıcı ara' }),
      h('div', { class: 'search-row' }, input, submit),
      h('p', {
        id: 'user-query-help',
        class: 'help',
        text: 'Şikayet dışı bildirimler (destek e-postası vb.) için. E-posta yalnız tam eşleşmeyle '
          + 'aranır ve sonuçlarda gösterilmez.',
      }),
      error);

    const search = async () => {
      const query = input.value.trim();
      state.userQuery = query;
      if (query.length < 2) {
        showError(error, 'En az 2 karakter yaz.');
        results.replaceChildren();
        return;
      }
      const token = ++viewToken;
      showError(error, null);
      setBusy(submit, true, 'Aranıyor…');
      results.setAttribute('aria-busy', 'true');
      try {
        const rows = await rpc('admin_find_users', { p_query: query });
        if (token !== viewToken) return;
        results.replaceChildren(...(rows.length ? rows.map(userCard) : [emptyState('Eşleşen kullanıcı yok.')]));
      } catch (err) {
        if (token === viewToken) showError(error, errorText(err));
      } finally {
        if (submit.isConnected) setBusy(submit, false);
        results.removeAttribute('aria-busy');
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      search();
    });

    view().replaceChildren(viewHeader('Kullanıcılar'), form, results);
    if (state.userQuery.length >= 2) search();
    else input.focus();
  }

  function userCard(row) {
    return h('article', { class: 'card' },
      h('div', { class: 'chips' },
        h('strong', { class: 'name', text: row.username }),
        h('span', { class: 'chip', text: `${row.report_total} şikayet` }),
        banBadge(row.banned, row.banned_until)),
      h('div', { class: 'actions' },
        button('Kimliği kopyala', () => copyText(row.user_id, 'Kullanıcı kimliği')),
        row.banned
          ? button('Yasağı kaldır', () => unbanDialog(row.user_id, row.username), 'primary')
          : button('Yasakla', () => banDialog({ userId: row.user_id, name: row.username }), 'danger')));
  }

  // ─── İşlem kaydı ──────────────────────────────────────────────────────────

  function actionDetails(row) {
    const details = row.details ?? {};
    if (row.action === 'ban') {
      return `${durationLabel(details.hours ?? null)} · ${details.reason ?? ''}`;
    }
    return details.note ? `Not: ${details.note}` : '';
  }

  async function loadLog() {
    const token = ++viewToken;
    const list = h('ol', { class: 'log', 'aria-busy': 'true' }, h('li', { class: 'muted', text: 'Yükleniyor…' }));
    view().replaceChildren(
      viewHeader('İşlem kaydı', button('Yenile', () => loadLog())),
      h('p', { class: 'muted small', text: 'Son 200 admin işlemi. Kayıtlar 1 yıl saklanır.' }),
      list);

    let rows;
    try {
      rows = await rpc('admin_recent_actions', { p_limit: 200 });
    } catch (err) {
      if (token === viewToken) list.replaceChildren(h('li', null, errorState(err, () => loadLog())));
      return;
    }
    if (token !== viewToken) return;
    list.removeAttribute('aria-busy');
    if (!rows.length) {
      list.replaceChildren(h('li', null, emptyState('Henüz işlem yok.')));
      return;
    }
    list.replaceChildren(...rows.map((row) => {
      const details = actionDetails(row);
      return h('li', { class: 'log-row' },
        h('time', { datetime: row.created_at, text: formatShort(row.created_at) }),
        h('div', { class: 'log-main' },
          h('strong', { text: ACTIONS[row.action] ?? row.action }),
          row.target_name ? ` · ${row.target_name}` : '',
          details ? h('p', { class: 'muted small', text: details }) : null),
        h('span', { class: 'muted small', text: row.admin_name }));
    }));
  }

  // ─── Diyaloglar ───────────────────────────────────────────────────────────

  dialog.addEventListener('close', () => dialog.replaceChildren());

  function textArea(id, label, { required = false, help = null, maxLength = 500 } = {}) {
    const input = h('textarea', {
      id, rows: '3', maxlength: String(maxLength), required,
      'aria-describedby': help ? `${id}-help` : null,
    });
    const wrap = h('div', { class: 'field' },
      h('label', { for: id, text: label }),
      input,
      help ? h('p', { id: `${id}-help`, class: 'help', text: help }) : null);
    return { wrap, input };
  }

  function radioGroup(name, legend, options, selected) {
    const inputs = options.map(([value]) => {
      const input = h('input', { type: 'radio', name, value, id: `${name}-${value}` });
      input.checked = value === selected;
      return input;
    });
    const el = h('fieldset', { class: 'radios' },
      h('legend', { text: legend }),
      options.map(([value, label], i) => h('label', { class: 'radio', for: `${name}-${value}` },
        inputs[i], h('span', { text: label }))));
    return { el, value: () => inputs.find((input) => input.checked)?.value };
  }

  /**
   * Onaylı işlem diyaloğu. `onConfirm` hata atarsa diyalog açık kalır ve hata
   * içinde gösterilir; başarılıysa kapanır. İşlem sürerken kapatılamaz.
   */
  function openDialog({ title, intro = null, fields = [], confirmText, tone = 'primary', onConfirm }) {
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Vazgeç' });
    const confirm = h('button', { type: 'submit', class: `btn btn-${tone}`, text: confirmText });
    const form = h('form', { class: 'stack' },
      h('h2', { id: 'dialog-title', text: title }),
      intro ? h('p', { class: 'muted', text: intro }) : null,
      fields,
      error,
      h('div', { class: 'dialog-actions' }, cancel, confirm));

    let busy = false;
    cancel.addEventListener('click', () => {
      if (!busy) dialog.close();
    });
    dialog.oncancel = (event) => {
      if (busy) event.preventDefault();
    };
    dialog.onclick = null;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      cancel.disabled = true;
      setBusy(confirm, true);
      showError(error, null);
      try {
        await onConfirm();
        busy = false;
        dialog.close();
      } catch (err) {
        busy = false;
        cancel.disabled = false;
        setBusy(confirm, false);
        showError(error, errorText(err));
      }
    });

    dialog.replaceChildren(form);
    dialog.showModal();
    // Yıkıcı işlemlerde varsayılan odak "Vazgeç"te kalır; metin alanı varsa oraya.
    form.querySelector('textarea')?.focus();
  }

  function openInfoDialog(title, content) {
    const close = h('button', { type: 'button', class: 'btn btn-primary', text: 'Kapat' });
    close.addEventListener('click', () => dialog.close());
    dialog.oncancel = null;
    // Arka plana tıklayınca kapanır (form diyaloğunda yazılan metin kaybolmasın diye yalnız burada).
    dialog.onclick = (event) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.replaceChildren(h('div', { class: 'stack' },
      h('h2', { id: 'dialog-title', text: title }),
      content,
      h('div', { class: 'dialog-actions' }, close)));
    dialog.showModal();
  }

  boot();
})();

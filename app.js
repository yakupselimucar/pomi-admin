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
    announcement_create: 'Duyuru yayınlandı',
    announcement_update: 'Duyuru düzenlendi',
    announcement_delete: 'Duyuru silindi',
  };
  // Sunucu ikizi `announcements_kind_check`; renkler uygulamadaki etiketlerle aynı.
  const ANNOUNCEMENT_KINDS = [
    ['feature', 'Yeni özellik', 'chip-warn'],
    ['update', 'Güncelleme', 'chip-done'],
    ['event', 'Etkinlik', ''],
    ['important', 'Önemli', 'chip-danger'],
    ['fix', 'Hata Düzeltmesi', 'chip-soft'],
  ];
  const ANNOUNCEMENT_TITLE_MAX = 80;
  const ANNOUNCEMENT_BODY_MAX = 600;
  // Duyuru dilleri. `tr` her zaman zorunludur; diğerleri düzenleme diyaloğunda seçerek eklenir.
  const ANNOUNCEMENT_LANGUAGES = [
    ['tr', 'Türkçe'], ['en', 'İngilizce'], ['de', 'Almanca'], ['fr', 'Fransızca'],
    ['es', 'İspanyolca'], ['it', 'İtalyanca'], ['pt', 'Portekizce'], ['ru', 'Rusça'],
    ['ar', 'Arapça'], ['fa', 'Farsça'], ['ur', 'Urduca'], ['hi', 'Hintçe'],
    ['zh', 'Çince'], ['ja', 'Japonca'], ['ko', 'Korece'], ['nl', 'Felemenkçe'],
    ['pl', 'Lehçe'], ['sv', 'İsveççe'], ['el', 'Yunanca'], ['az', 'Azerbaycan Türkçesi'],
    ['uk', 'Ukraynaca'], ['ro', 'Rumence'], ['cs', 'Çekçe'], ['hu', 'Macarca'],
    ['th', 'Tayca'], ['vi', 'Vietnamca'], ['id', 'Endonezce'], ['ms', 'Malayca'],
    ['he', 'İbranice'], ['bg', 'Bulgarca'],
  ];
  const BAN_DURATIONS = [
    ['24', '24 saat'],
    ['168', '7 gün'],
    ['720', '30 gün'],
    ['permanent', 'Kalıcı'],
  ];
  const BAN_SCOPES = [
    { id: 'room_create', label: 'Oda Kurma Engeli', desc: 'Yeni oda açamaz (saldırı ve troll odaları önler)', icon: '🚫' },
    { id: 'chat', label: 'Sohbet & Tepki Engeli', desc: 'Odalarda mesaj yazamaz ve tepki veremez', icon: '💬' },
    { id: 'room_join', label: 'Odaya Katılma Engeli', desc: 'Odalara üye olamaz ve giremez', icon: '🚪' },
    { id: 'name_change', label: 'İsim Değiştirme Engeli', desc: 'Profilindeki adını değiştiremez', icon: '✏️' },
  ];
  const BAN_REASON_PRESETS = [
    'Uygunsuz oda adı veya oda açarak rahatsızlık verme.',
    'Uygunsuz, taciz veya nefret içeren kullanıcı adı.',
    'Oda sohbetinde küfür, taciz veya troll davranış.',
    'Spam, reklam veya koordineli saldırı.',
    'Topluluk kurallarının ağır ihlali.',
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
    ['invalid_kind', 'Duyuru türü seç.'],
    ['tr_required', 'Türkçe başlık ve metin zorunlu.'],
    ['translation_incomplete', 'Eklediğin her dil için başlık ve metnin ikisini de doldur, ya da o dili kaldır.'],
    ['translation_too_long', 'Başlık en fazla 80, metin en fazla 600 karakter olabilir.'],
    ['announcement_not_found', 'Duyuru bulunamadı (silinmiş olabilir).'],
    ['room_create_banned', 'Bu kullanıcının oda kurma yetkisi askıya alınmış.'],
    ['name_change_banned', 'Bu kullanıcının isim değiştirme yetkisi askıya alınmış.'],
    ['room_join_banned', 'Bu kullanıcının odalara katılma yetkisi askıya alınmış.'],
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
    ['announcements', 'Duyurular'],
    ['rooms', 'Odalar'],
    ['bans', 'Yasaklılar'],
    ['users', 'Kullanıcılar'],
    ['log', 'İşlem kaydı'],
  ];
  const VIEWS = {
    reports: () => loadReports(),
    announcements: () => loadAnnouncements(),
    rooms: () => loadRooms(),
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
    const images = await loadCaseImages(rows);
    if (token !== viewToken) return;
    state.reportsLoadedAt = Date.now();
    if (state.reportStatus === 'open') setOpenCount(rows.length);
    list.removeAttribute('aria-busy');
    list.replaceChildren(...(rows.length
      ? rows.map((row) => caseCard(row, images.get(row.message_id)))
      : [emptyState(state.reportStatus === 'open' ? 'Açık şikayet yok. 🎉' : 'Kayıt yok.')]));
  }

  /**
   * Fotoğraflı vakalar: mesaj kimliği → 10 dakikalık imzalı adres. Tek RPC.
   * Fotoğraf özelliği kurulmamışsa (fonksiyon yok) boş döner, liste yine açılır.
   */
  async function loadCaseImages(rows) {
    const ids = [...new Set(rows.map((row) => row.message_id).filter(Boolean))];
    if (!ids.length) return new Map();
    try {
      const images = await rpc('admin_room_chat_image_urls', { p_message_ids: ids });
      return new Map(images.map((image) => [image.message_id, image]));
    } catch (err) {
      console.warn('fotoğraflar okunamadı', err);
      return new Map();
    }
  }

  /**
   * Şikayet edilen fotoğraf. Varsayılan kapalı (metin gibi): panelde gezinirken
   * istemeden görülmesin. Görsel başka origin'de (Cloudflare Worker) ve yalnız
   * bu panelin origin'ine CORS açık; `<img src>` yerine fetch → blob, çünkü
   * Worker başka sitelerin gömmesini engelliyor (CORP same-origin).
   */
  function photoBlock(image) {
    const note = image.quarantined
      ? 'Kaldırıldı · yalnız moderasyon görür (30 gün)'
      : 'Yayında · 7 gün sonra silinir';
    const status = h('span', { class: 'muted small', text: note });
    const holder = h('div', { class: 'content-photo' });
    const reveal = button('Fotoğrafı göster', async () => {
      setBusy(reveal, true, 'Yükleniyor…');
      try {
        const res = await fetch(image.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        holder.replaceChildren(h('img', { src: url, alt: 'Şikayet edilen fotoğraf' }));
        reveal.remove();
      } catch (err) {
        setBusy(reveal, false);
        status.textContent = 'Fotoğraf yüklenemedi — bağlantının süresi dolmuş olabilir, listeyi yenile.';
        console.warn('fotoğraf', err);
      }
    });
    return h('div', { class: 'content-photo-wrap' }, holder, h('div', { class: 'row' }, reveal, status));
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

  /**
   * Vakayı kimin açtığı. Tek kişiden gelen seri şikayet ile gerçek bir
   * kalabalık tepkisi farklı şeylerdir; moderatör bunu kartta görmeli.
   */
  function reporterValue(row) {
    const names = (row.reporter_names ?? []).filter(Boolean);
    const people = row.reporter_count ?? names.length;
    if (!names.length) return [h('span', { class: 'muted', text: 'Bilinmiyor' })];
    const shown = names.slice(0, 3).join(', ');
    const rest = names.length > 3 ? ` +${names.length - 3}` : '';
    return [
      h('strong', { text: shown + rest }),
      people === 1 && row.report_count > 1
        ? h('span', { class: 'chip chip-warn chip-small', text: 'tek kişiden' })
        : null,
    ];
  }

  function contentBlock(row, image) {
    const key = row.case_key;
    // Açıklamasız fotoğrafta uygulama gövdeye yalnız '📷' yazar.
    const hasText = typeof row.body_snapshot === 'string' && row.body_snapshot.length > 0
      && !(image && row.body_snapshot === '📷');
    const body = h('p', {
      class: 'content-body',
      text: hasText ? row.body_snapshot : image ? 'Açıklamasız fotoğraf.' : 'İçerik kaydı yok.',
    });
    const wrap = h('div', { class: 'content' }, body);
    if (image) wrap.append(photoBlock(image));
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

  function caseCard(row, image) {
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
      metaItem('Şikayet eden', ...reporterValue(row)),
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
      contentBlock(row, image),
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

  // ─── Odalar ───────────────────────────────────────────────────────────────

  /**
   * Tüm odalar, yeniden eskiye. GİZLİ odalar da listelenir: uygunsuz
   * adlandırma gizli odada da oluyor ve kimse şikayet etmeden görülmüyordu.
   * Sunucu tarafı `admin_list_rooms` (SECURITY DEFINER + assert_app_admin).
   *
   * Mesaj içeriği DÖNMEZ; sohbeti okumak şikayet akışına ait. Buradaki amaç
   * oda adını ve ölçeğini taramak, gerekirse sahibini tek tıkla yasaklamak.
   */
  async function loadRooms() {
    const filterInput = h('input', {
      type: 'search',
      class: 'bans-filter',
      autocomplete: 'off',
      placeholder: 'Oda adı, sahip adı ya da oda kimliği…',
    });
    const list = h('div', { class: 'list', 'aria-busy': 'true' },
      h('p', { class: 'muted', text: 'Yükleniyor…' }));

    view().replaceChildren(
      viewHeader('Odalar', button('Yenile', () => loadRooms())),
      h('div', { class: 'search-filter-wrap' }, filterInput),
      list,
    );

    // Sunucu taraması (500'e kadar) — kutu boşsa tüm liste gelir.
    let debounceTimer = 0;
    filterInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchRooms(filterInput.value.trim()), 250);
    });

    async function fetchRooms(query) {
      const myToken = ++viewToken;
      list.setAttribute('aria-busy', 'true');
      let rows;
      try {
        rows = await rpc('admin_list_rooms', { p_query: query || null, p_limit: 500 });
      } catch (err) {
        if (myToken === viewToken) list.replaceChildren(errorState(err, () => fetchRooms(query)));
        return;
      }
      if (myToken !== viewToken) return;
      list.removeAttribute('aria-busy');
      if (!rows.length) {
        list.replaceChildren(emptyState(query ? 'Eşleşen oda yok.' : 'Hiç oda yok.'));
        return;
      }
      list.replaceChildren(...rows.map(roomCard));
    }

    function roomCard(row) {
      const full = row.member_count >= row.max_members;
      return h('article', { class: 'card' },
        h('div', { class: 'chips' },
          h('strong', { class: 'name', text: `${row.emoji ?? '🌱'} ${row.name}` }),
          row.is_public
            ? h('span', { class: 'chip chip-small', text: '🌍 Herkese açık' })
            : h('span', { class: 'chip chip-soft chip-small', text: '🔒 Gizli' }),
          h('span', {
            class: full ? 'chip chip-warn chip-small' : 'chip chip-small',
            text: `${row.member_count}/${row.max_members} kişi`,
          }),
          // `banBadge` bitiş tarihi ister; bu listede yok. Yasağın süresini
          // Yasaklılar sekmesi gösterir, burada yalnız işaret yeter.
          row.owner_banned
            ? h('span', { class: 'chip chip-danger chip-small', text: 'Kurucu yasaklı' })
            : null),
        h('dl', { class: 'meta' },
          metaItem('Kurucu', row.owner_username ?? '(hesap silinmiş)'),
          metaItem('Kuruldu', formatDate(row.created_at)),
          metaItem('Mesaj', String(row.message_count)),
          metaItem('Son mesaj', row.last_message_at ? formatDate(row.last_message_at) : '—'),
          row.invite_code ? metaItem('Davet kodu', row.invite_code) : null),
        h('div', { class: 'actions' },
          button('Oda kimliğini kopyala', () => copyText(row.room_id, 'Oda kimliği')),
          row.owner_id
            ? button('Kurucuyu yasakla', () => banDialog({
                userId: row.owner_id,
                name: row.owner_username,
              }), 'danger')
            : null));
    }

    await fetchRooms('');
  }

  // ─── Yasak ────────────────────────────────────────────────────────────────

  /** Geniş yasak diyaloğunda başlıklı bir blok. */
  function banSection(title, help, ...content) {
    return h('section', { class: 'ban-section' },
      h('h3', { class: 'ban-section-title', text: title }),
      help ? h('p', { class: 'help', text: help }) : null,
      content);
  }

  function banDialog({ userId = null, name = null, reportIds = null, messageLive = false } = {}) {
    let targetUserId = userId;
    let targetName = name;
    let selectedUserEl = null;
    let searchWrapEl = null;

    // 1) Kullanıcı Arama & Seçim Alanı
    const searchSection = h('div', { class: 'stack' });

    function updateSelectionView() {
      if (targetUserId) {
        if (searchWrapEl) searchWrapEl.hidden = true;
        selectedUserEl.hidden = false;
        // `replaceChildren` null'ı "null" metnine çevirir; h() gibi elemez.
        // Kartın sağ üstünde görünen "null" yazısı bundandı.
        const children = [
          h('div', { class: 'user-select-info' },
            h('div', { class: 'user-select-title' },
              h('span', { text: `👤 @${targetName ?? 'Kullanıcı'}` }),
              h('span', { class: 'chip chip-small chip-done', text: 'Hedef Kullanıcı' })),
            h('span', { class: 'muted small', text: `Kimlik: ${targetUserId}` })),
        ];
        if (!userId) {
          children.push(button('Değiştir', () => {
            targetUserId = null;
            targetName = null;
            updateSelectionView();
          }, 'ghost', { class: 'btn btn-ghost btn-small' }));
        }
        selectedUserEl.replaceChildren(...children);
      } else {
        selectedUserEl.hidden = true;
        if (searchWrapEl) {
          searchWrapEl.hidden = false;
          searchWrapEl.querySelector('input')?.focus();
        }
      }
    }

    selectedUserEl = h('div', { class: 'user-select-card', hidden: true });

    if (!targetUserId) {
      const searchInput = h('input', {
        id: 'ban-user-query',
        type: 'search',
        autocomplete: 'off',
        placeholder: 'Kullanıcı adı, tam e-posta ya da UUID kimlik…',
      });
      const dropdown = h('div', { class: 'user-search-dropdown', hidden: true });
      searchWrapEl = h('div', { class: 'field' },
        h('label', { for: 'ban-user-query', text: 'Yasaklanacak kullanıcıyı bul' }),
        h('div', { class: 'user-search-wrap' }, searchInput, dropdown),
        h('p', { class: 'help', text: 'Kullanıcı adı yazıldıkça sonuçlar listelenir veya doğrudan UUID kimliği girilebilir.' }));

      let debounceTimer = 0;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const query = searchInput.value.trim();
        if (query.length < 2) {
          dropdown.hidden = true;
          dropdown.replaceChildren();
          return;
        }

        debounceTimer = setTimeout(async () => {
          try {
            const rows = await rpc('admin_find_users', { p_query: query });
            if (!rows.length) {
              dropdown.hidden = false;
              dropdown.replaceChildren(
                h('div', { class: 'user-candidate', text: 'Eşleşen kullanıcı bulunamadı.' })
              );
              return;
            }
            dropdown.hidden = false;
            dropdown.replaceChildren(...rows.map((row) => {
              return h('button', {
                type: 'button',
                class: 'user-candidate',
                onclick: () => {
                  targetUserId = row.user_id;
                  targetName = row.username;
                  dropdown.hidden = true;
                  dropdown.replaceChildren();
                  searchInput.value = '';
                  updateSelectionView();
                },
              },
              h('div', { class: 'user-candidate-info' },
                h('strong', { class: 'user-candidate-name', text: row.username }),
                h('span', { class: 'chip chip-small', text: `${row.report_total} şikayet` })),
              banBadge(row.banned, row.banned_until));
            }));
          } catch (err) {
            dropdown.hidden = false;
            dropdown.replaceChildren(
              h('div', { class: 'user-candidate', text: `Arama hatası: ${errorText(err)}` })
            );
          }
        }, 250);
      });

      searchSection.append(searchWrapEl, selectedUserEl);
    } else {
      searchSection.append(selectedUserEl);
    }
    updateSelectionView();

    // 2) Kapsam Seçimi (Neye Engel Atılacağı)
    const masterCheck = h('input', { type: 'checkbox', id: 'scope-master' });
    masterCheck.checked = true;

    const scopeBoxes = {};
    const scopeGrid = h('div', { class: 'scope-grid' });

    BAN_SCOPES.forEach((scope) => {
      const box = h('input', { type: 'checkbox', id: `scope-${scope.id}` });
      box.checked = true;
      scopeBoxes[scope.id] = box;

      box.addEventListener('change', () => {
        const allChecked = BAN_SCOPES.every((s) => scopeBoxes[s.id].checked);
        masterCheck.checked = allChecked;
      });

      const label = h('label', { class: 'scope-box', for: `scope-${scope.id}` },
        box,
        h('div', { class: 'scope-box-text' },
          h('span', { class: 'scope-box-title', text: `${scope.icon} ${scope.label}` }),
          h('span', { class: 'scope-box-desc', text: scope.desc })));
      scopeGrid.append(label);
    });

    masterCheck.addEventListener('change', () => {
      const isChecked = masterCheck.checked;
      BAN_SCOPES.forEach((s) => {
        scopeBoxes[s.id].checked = isChecked;
      });
    });

    const scopeContainer = h('div', { class: 'scope-container' },
      h('label', { class: 'scope-master', for: 'scope-master' },
        masterCheck,
        h('span', { text: 'Tüm topluluk özellikleri — tam engel' }),
        h('span', { class: 'chip chip-small', text: 'önerilen' })),
      scopeGrid);

    // 3) Saldırı & Hızlı Temizlik Önlemleri
    const resetNameBox = h('input', { type: 'checkbox', id: 'ban-reset-name' });
    const closeRoomsBox = h('input', { type: 'checkbox', id: 'ban-close-rooms' });
    const kickRoomsBox = h('input', { type: 'checkbox', id: 'ban-kick-rooms' });

    // Üçü de varsayılan olarak KAPALI. Oda silmek geri alınamaz ve odadaki
    // diğer herkesi de vurur — en kalabalık odada 48 kişi var. Tek bir
    // kötü mesaj yüzünden yasaklanan birinin meşru odası buharlaşmamalı.
    // Saldırı senaryosu için üçünü birden açan bir ön ayar aşağıda.

    // Tek tık: kalıcı tam yasak + tüm temizlik. "Epstein Adası" vakası gibi
    // dakikaların önemli olduğu anlarda kutuları tek tek aramamak için.
    const raidPreset = h('button', {
      type: 'button',
      class: 'btn btn-danger btn-small',
      text: '🚨 Saldırı ön ayarı',
      title: 'Kalıcı tam yasak + odalarını sil + adını sıfırla + odalardan çıkar',
      onclick: () => {
        masterCheck.checked = true;
        BAN_SCOPES.forEach((sc) => { scopeBoxes[sc.id].checked = true; });
        closeRoomsBox.checked = true;
        resetNameBox.checked = true;
        kickRoomsBox.checked = true;
        duration.select('permanent');
        if (!reason.input.value.trim()) {
          reason.input.value = BAN_REASON_PRESETS[3];
        }
      },
    });

    const countermeasuresCard = h('div', { class: 'countermeasure-card' },
      h('div', { class: 'countermeasure-header' },
        h('span', { text: 'Acil temizlik' }),
        raidPreset),
      h('p', { class: 'help', text: 'Geri alınamaz; yalnız işaretlediklerin uygulanır. Oda silmek odadaki herkesi etkiler.' }),
      h('div', { class: 'countermeasure-options' },
        h('label', { class: 'countermeasure-option', for: 'ban-close-rooms' },
          closeRoomsBox,
          h('span', { text: 'Kullanıcının açtığı tüm odaları sil (içindeki herkes ve mesajlar dahil)' })),
        h('label', { class: 'countermeasure-option', for: 'ban-reset-name' },
          resetNameBox,
          h('span', { text: 'Kullanıcı adını güvenli ada sıfırla (Domates#... yap)' })),
        h('label', { class: 'countermeasure-option', for: 'ban-kick-rooms' },
          kickRoomsBox,
          h('span', { text: 'Kullanıcıyı üye olduğu tüm odalardan çıkar' }))));

    // 4) Süre & Gerekçe
    const duration = radioGroup('ban-duration', 'Süre', BAN_DURATIONS, '24', { hiddenLegend: true });
    const reason = textArea('ban-reason', 'Gerekçe', {
      required: true,
      hiddenLabel: true,
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

    // Geniş diyalogda her şey tek ekranda: solda "kime ve neye", sağda
    // "ne kadar, neden ve hangi temizlik". Kaydırmadan karar verilebilsin.
    const layout = h('div', { class: 'ban-layout' },
      h('div', { class: 'ban-col' },
        banSection('Yasak kapsamı', 'Hangi topluluk özellikleri kapansın?', scopeContainer),
        countermeasuresCard),
      h('div', { class: 'ban-col' },
        banSection('Süre', null, duration.el, permanentHint),
        banSection('Gerekçe', 'Kullanıcı uygulamada bu metni görür.', reason.wrap, presets)));

    let removeBox = null;
    const fields = [searchSection, layout];
    if (reportIds && messageLive) {
      removeBox = h('input', { type: 'checkbox', id: 'ban-remove' });
      removeBox.checked = true;
      fields.push(h('label', { class: 'check', for: 'ban-remove' },
        removeBox, h('span', { text: 'Şikayet edilen mesajı da kaldır' })));
    }

    openDialog({
      title: targetName ? `${targetName} yasaklansın mı?` : 'Kullanıcıyı Yasakla',
      fields,
      confirmText: 'Yasakla',
      tone: 'danger',
      size: 'wide',
      onConfirm: async () => {
        if (!targetUserId) {
          throw new UserError('Önce yasaklanacak bir kullanıcı seç.');
        }
        const text = reason.input.value.trim();
        if (!text) {
          reason.input.focus();
          throw new UserError('Gerekçe zorunlu — kullanıcıya gösterilir.');
        }

        const selectedScopes = [];
        if (masterCheck.checked) {
          selectedScopes.push('all');
        } else {
          for (const s of BAN_SCOPES) {
            if (scopeBoxes[s.id]?.checked) selectedScopes.push(s.id);
          }
        }
        if (!selectedScopes.length) {
          throw new UserError('En az bir yasak kapsamı seçmelisin.');
        }

        const choice = duration.value() ?? '24';
        const hours = choice === 'permanent' ? null : Number(choice);

        // Eski imzaya düşen bir fallback BİLEREK yok. Eski `admin_ban_user`
        // kapsam tanımıyor, yani "yalnız sohbeti kapat" isteği sessizce TAM
        // yasağa dönüşürdü — hatalı tarafı ağır olan bir sessiz yükseltme.
        // Panel ve migration birlikte yayına gidiyor; RPC yoksa hata görünsün.
        await rpc('admin_ban_user', {
          p_user_id: targetUserId,
          p_hours: hours,
          p_reason: text,
          p_report_ids: reportIds ?? null,
          p_scopes: selectedScopes,
          p_reset_username: resetNameBox.checked,
          p_close_rooms: closeRoomsBox.checked,
          p_kick_rooms: kickRoomsBox.checked,
        });

        if (removeBox?.checked) {
          try {
            await rpc('admin_resolve_reports', { p_report_ids: reportIds, p_action: 'remove', p_note: null });
          } catch (err) {
            toast(`Yasaklandı, ama mesaj kaldırılamadı: ${errorText(err)}`, 'error');
            afterMutation();
            return;
          }
        }
        toast(`${targetName ?? 'Kullanıcı'} yasaklandı (${durationLabel(hours)})`);
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
    const filterInput = h('input', {
      type: 'search',
      class: 'bans-filter',
      placeholder: 'Yasaklılar listesinde ara (kullanıcı adı veya gerekçe)…',
      autocomplete: 'off',
    });
    const filterWrap = h('div', { class: 'search-filter-wrap' }, filterInput);

    const list = h('div', { class: 'list', 'aria-busy': 'true' }, h('p', { class: 'muted', text: 'Yükleniyor…' }));
    view().replaceChildren(
      viewHeader(
        'Yasaklılar',
        button('+ Kullanıcı Engelle', () => banDialog({}), 'danger'),
        button('Yenile', () => loadBans())
      ),
      filterWrap,
      list
    );

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
      filterWrap.hidden = true;
      list.replaceChildren(emptyState('Yasaklı kullanıcı yok.'));
      return;
    }

    function renderFiltered() {
      const q = filterInput.value.trim().toLowerCase();
      const filtered = q
        ? rows.filter((r) =>
            (r.username ?? '').toLowerCase().includes(q) ||
            (r.ban_reason ?? '').toLowerCase().includes(q) ||
            (r.user_id ?? '').toLowerCase().includes(q))
        : rows;

      if (!filtered.length) {
        list.replaceChildren(emptyState('Aramaya uygun yasaklı kullanıcı bulunamadı.'));
        return;
      }

      list.replaceChildren(...filtered.map((row) => {
        const scopes = row.ban_scopes ?? ['all'];
        const isAll = scopes.includes('all');

        const scopeChips = isAll
          ? null
          : h('div', { class: 'scope-badge-group' },
              scopes.map((s) => {
                const def = BAN_SCOPES.find((x) => x.id === s);
                return h('span', { class: 'chip chip-soft chip-small', text: `${def?.icon ?? '🔒'} ${def?.label ?? s}` });
              }));

        return h('article', { class: 'card' },
          h('div', { class: 'chips' },
            h('strong', { class: 'name', text: row.username }),
            row.permanent
              ? h('span', { class: 'chip chip-danger', text: 'Kalıcı' })
              : h('span', {
                  class: 'chip chip-warn',
                  text: `${formatShort(row.banned_until)}'e dek · ${formatSpan(toDate(row.banned_until).getTime() - Date.now())} kaldı`,
                })),
          scopeChips,
          h('dl', { class: 'meta' },
            metaItem('Gerekçe', row.ban_reason ?? '—'),
            metaItem('Yasaklandı', formatDate(row.banned_at)),
            metaItem('Toplam şikayet', String(row.report_total))),
          h('div', { class: 'actions' },
            button('Kimliği kopyala', () => copyText(row.user_id, 'Kullanıcı kimliği')),
            button('Yasağı kaldır', () => unbanDialog(row.user_id, row.username), 'primary')));
      }));
    }

    filterInput.addEventListener('input', renderFiltered);
    renderFiltered();
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
    if (row.action.startsWith('announcement_')) {
      return details.title ? `“${details.title}”` : '';
    }
    if (row.action === 'ban') {
      let scopesDesc = '';
      if (details.scopes?.length && !details.scopes.includes('all')) {
        const names = details.scopes.map((s) => BAN_SCOPES.find((x) => x.id === s)?.label ?? s).join(', ');
        scopesDesc = `[${names}] `;
      }
      const resetNote = details.reset_username ? ' · İsim sıfırlandı' : '';
      const closeNote = details.close_rooms ? ' · Odalar kapatıldı' : '';
      return `${scopesDesc}${durationLabel(details.hours ?? null)} · ${details.reason ?? ''}${resetNote}${closeNote}`;
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

  // ─── Duyurular ────────────────────────────────────────────────────────────

  function kindChip(kind) {
    const [, label, tone] = ANNOUNCEMENT_KINDS.find(([id]) => id === kind) ?? [kind, kind, ''];
    return h('span', { class: `chip ${tone}`.trim(), text: label });
  }

  async function loadAnnouncements() {
    const token = ++viewToken;
    const list = h('div', { class: 'list', 'aria-busy': 'true' }, h('p', { class: 'muted', text: 'Yükleniyor…' }));
    view().replaceChildren(
      viewHeader('Duyurular',
        button('Yenile', () => loadAnnouncements()),
        button('Yeni duyuru', () => announcementDialog(null), 'primary')),
      h('p', {
        class: 'muted small',
        text: 'Uygulamada sayaç ekranındaki raydan, zil ikonuyla açılır. Okunmamış olanlar rozetle '
          + 'görünür. Push bildirimi gönderilmez. Yayın zamanı ileri bir tarihse duyuru o ana kadar gizli kalır.',
      }),
      list);

    let rows;
    try {
      rows = await rpc('admin_list_announcements', { p_limit: 200 });
    } catch (err) {
      if (token === viewToken) list.replaceChildren(errorState(err, () => loadAnnouncements()));
      return;
    }
    if (token !== viewToken) return;
    list.removeAttribute('aria-busy');
    list.replaceChildren(...(rows.length ? rows.map(announcementCard) : [emptyState('Henüz duyuru yok.')]));
  }

  function announcementCard(row) {
    const scheduled = (toDate(row.published_at)?.getTime() ?? 0) > Date.now();
    const translations = row.translations ?? {};
    const tr = translations.tr ?? {};
    const others = Object.entries(translations).filter(([lang]) => lang !== 'tr');
    return h('article', { class: 'card announcement-card' },
      h('div', { class: 'announcement-header' },
        h('div', { class: 'chips' },
          kindChip(row.kind),
          scheduled
            ? h('span', { class: 'chip chip-soft', text: `Zamanlandı · ${formatShort(row.published_at)}` })
            : h('span', { class: 'chip chip-ok', text: 'Yayında' }),
          others.length
            ? h('span', { class: 'chip chip-small', text: `+${others.length} dil` })
            : h('span', { class: 'chip chip-small', text: 'Yalnız TR' })),
        h('div', { class: 'announcement-author', title: 'Duyuruyu oluşturan yönetici' },
          h('span', { class: 'author-icon', 'aria-hidden': 'true', text: '✍️' }),
          h('span', { class: 'author-label', text: 'Yazan:' }),
          h('strong', { class: 'author-name', text: row.author_name ?? '—' }))),
      h('strong', { class: 'name announcement-title', text: tr.title ?? '' }),
      h('p', { class: 'announcement-body', text: tr.body ?? '' }),
      others.length
        ? h('details', null,
          h('summary', { text: 'Diğer diller' }),
          others.map(([lang, value]) => h('div', { class: 'stack' },
            h('strong', { text: `${langLabel(lang)}: ${value.title}` }),
            h('p', { class: 'announcement-body', text: value.body ?? '' }))))
        : null,
      h('dl', { class: 'meta' },
        metaItem('Duyuru saati', formatDate(row.published_at)),
        row.updated_at && row.updated_at !== row.created_at
          ? metaItem('Son düzenleme', formatDate(row.updated_at))
          : null),
      h('div', { class: 'actions' },
        button('Düzenle', () => announcementDialog(row)),
        button('Sil', () => deleteAnnouncementDialog(row), 'danger')));
  }

  function langLabel(code) {
    return ANNOUNCEMENT_LANGUAGES.find(([id]) => id === code)?.[1] ?? code;
  }

  function textInput(id, label, { maxLength, required = false, help = null, value = '' } = {}) {
    const input = h('input', {
      id, type: 'text', maxlength: String(maxLength), required, autocomplete: 'off',
      'aria-describedby': help ? `${id}-help` : null,
    });
    input.value = value;
    const wrap = h('div', { class: 'field' },
      h('label', { for: id, text: label }),
      input,
      help ? h('p', { id: `${id}-help`, class: 'help', text: help }) : null);
    return { wrap, input };
  }

  /** Bir dil için başlık+metin alanlarını oluşturur; TR hariç kaldırma düğmesi taşır. */
  function languageBlock(lang, { title = '', body = '' } = {}, onRemove) {
    const titleField = textInput(`ann-title-${lang}`, `Başlık (${langLabel(lang)})`, {
      maxLength: ANNOUNCEMENT_TITLE_MAX, required: lang === 'tr', value: title,
    });
    const bodyField = textArea(`ann-body-${lang}`, `Metin (${langLabel(lang)})`, {
      required: lang === 'tr', maxLength: ANNOUNCEMENT_BODY_MAX,
    });
    bodyField.input.value = body;
    const wrap = h('div', { class: 'stack lang-block' },
      lang === 'tr'
        ? null
        : h('div', { class: 'actions' },
          h('span', { class: 'muted small', text: langLabel(lang) }),
          button('Bu dili kaldır', () => onRemove(), 'ghost')),
      titleField.wrap, bodyField.wrap);
    return { lang, wrap, titleField, bodyField };
  }

  function announcementDialog(row) {
    const editing = Boolean(row);
    const kind = radioGroup('ann-kind', 'Tür',
      ANNOUNCEMENT_KINDS.map(([id, label]) => [id, label]), row?.kind ?? 'feature');

    const initialTranslations = row?.translations ?? { tr: { title: '', body: '' } };
    const blocks = new Map();
    const langsWrap = h('div', { class: 'stack' });

    const addLangSelect = h('select', { id: 'ann-add-lang' });
    const addLangField = h('div', { class: 'field' },
      h('label', { for: 'ann-add-lang', text: 'Dil ekle' }),
      h('div', { class: 'actions' },
        addLangSelect,
        button('Ekle', () => {
          const lang = addLangSelect.value;
          if (!lang || blocks.has(lang)) return;
          addBlock(lang, {});
          refreshLangOptions();
        })));

    function refreshLangOptions() {
      const available = ANNOUNCEMENT_LANGUAGES.filter(([id]) => !blocks.has(id));
      addLangSelect.replaceChildren(
        ...available.map(([id, label]) => h('option', { value: id, text: label })));
      addLangField.hidden = available.length === 0;
    }

    function addBlock(lang, value) {
      const block = languageBlock(lang, value, () => {
        blocks.delete(lang);
        block.wrap.remove();
        refreshLangOptions();
      });
      blocks.set(lang, block);
      langsWrap.append(block.wrap);
    }

    addBlock('tr', initialTranslations.tr ?? {});
    Object.entries(initialTranslations)
      .filter(([lang]) => lang !== 'tr')
      .forEach(([lang, value]) => addBlock(lang, value));
    refreshLangOptions();

    openDialog({
      title: editing ? 'Duyuruyu düzenle' : 'Yeni duyuru',
      intro: editing
        ? 'Yayın saati değişmez; ilk yayınlandığı an korunur.'
        : 'Yayın saati kaydettiğin an otomatik atanır.',
      fields: [kind.el, langsWrap, addLangField],
      confirmText: editing ? 'Kaydet' : 'Yayınla',
      onConfirm: async () => {
        const translations = {};
        for (const { lang, titleField, bodyField } of blocks.values()) {
          const title = titleField.input.value.trim();
          const body = bodyField.input.value.trim();
          if (!title && !body) continue;
          if (!title || !body) {
            throw new UserError(`${langLabel(lang)} için başlık ve metnin ikisini de doldur, ya da o dili kaldır.`);
          }
          translations[lang] = { title, body };
        }
        if (!translations.tr) throw new UserError('Türkçe başlık ve metin zorunlu.');
        await rpc('admin_save_announcement', {
          p_id: row?.id ?? null,
          p_kind: kind.value(),
          p_translations: translations,
        });
        toast(editing ? 'Duyuru kaydedildi' : 'Duyuru yayınlandı');
        afterMutation();
      },
    });
    // Metin alanı yerine başlıkta başla.
    blocks.get('tr').titleField.input.focus();
  }

  function deleteAnnouncementDialog(row) {
    openDialog({
      title: 'Duyuru silinsin mi?',
      intro: `“${row.translations?.tr?.title ?? ''}” tüm kullanıcılardan kaldırılır. Bu işlem geri alınamaz.`,
      confirmText: 'Sil',
      tone: 'danger',
      onConfirm: async () => {
        await rpc('admin_delete_announcement', { p_id: row.id });
        toast('Duyuru silindi');
        afterMutation();
      },
    });
  }

  // ─── Diyaloglar ───────────────────────────────────────────────────────────

  dialog.addEventListener('close', () => dialog.replaceChildren());

  function textArea(id, label, { required = false, help = null, maxLength = 500, hiddenLabel = false } = {}) {
    const input = h('textarea', {
      id, rows: '3', maxlength: String(maxLength), required,
      'aria-describedby': help ? `${id}-help` : null,
    });
    const wrap = h('div', { class: 'field' },
      h('label', { for: id, text: label, class: hiddenLabel ? 'visually-hidden' : null }),
      input,
      help ? h('p', { id: `${id}-help`, class: 'help', text: help }) : null);
    return { wrap, input };
  }

  function radioGroup(name, legend, options, selected, { hiddenLegend = false } = {}) {
    const inputs = options.map(([value]) => {
      const input = h('input', { type: 'radio', name, value, id: `${name}-${value}` });
      input.checked = value === selected;
      return input;
    });
    const el = h('fieldset', { class: 'radios' },
      h('legend', { text: legend, class: hiddenLegend ? 'visually-hidden' : null }),
      options.map(([value, label], i) => h('label', { class: 'radio', for: `${name}-${value}` },
        inputs[i], h('span', { text: label }))));
    return {
      el,
      value: () => inputs.find((input) => input.checked)?.value,
      // Ön ayar butonları seçimi programatik değiştirebilsin diye.
      select: (value) => {
        const match = inputs.find((input) => input.value === String(value));
        if (match) match.checked = true;
      },
    };
  }

  /**
   * Onaylı işlem diyaloğu. `onConfirm` hata atarsa diyalog açık kalır ve hata
   * içinde gösterilir; başarılıysa kapanır. İşlem sürerken kapatılamaz.
   */
  function openDialog({ title, intro = null, fields = [], confirmText, tone = 'primary', size = 'default', onConfirm }) {
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: 'Vazgeç' });
    const confirm = h('button', { type: 'submit', class: `btn btn-${tone}`, text: confirmText });
    // Başlık ve onay satırı sabit, yalnız gövde kayar: uzun formlarda
    // (yasaklama) "Yasakla" düğmesi ekranın altına kaçmasın.
    const form = h('form', { class: 'dialog-form' },
      h('h2', { id: 'dialog-title', text: title }),
      h('div', { class: 'dialog-body' },
        intro ? h('p', { class: 'muted', text: intro }) : null,
        fields,
        error),
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

    dialog.className = size === 'wide' ? 'dialog-wide' : '';
    dialog.replaceChildren(form);
    dialog.showModal();
    // Yıkıcı işlemlerde varsayılan odak "Vazgeç"te kalır; metin alanı varsa oraya.
    // Dokunmatikte odaklanmıyoruz: klavye anında açılıp diyaloğun üst yarısını
    // (hedef kullanıcı ve kapsam seçimi) ekran dışına itiyordu.
    if (!window.matchMedia?.('(pointer: coarse)').matches) {
      form.querySelector('textarea')?.focus();
    }
  }

  function openInfoDialog(title, content) {
    const close = h('button', { type: 'button', class: 'btn btn-primary', text: 'Kapat' });
    close.addEventListener('click', () => dialog.close());
    dialog.oncancel = null;
    // Arka plana tıklayınca kapanır (form diyaloğunda yazılan metin kaybolmasın diye yalnız burada).
    dialog.onclick = (event) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.className = '';
    dialog.replaceChildren(h('div', { class: 'dialog-form' },
      h('h2', { id: 'dialog-title', text: title }),
      h('div', { class: 'dialog-body' }, content),
      h('div', { class: 'dialog-actions' }, close)));
    dialog.showModal();
  }

  boot();
})();

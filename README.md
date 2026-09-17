# Pomi Moderasyon Paneli

Pomi oda sohbeti şikayetlerini incelemek ve topluluk yasaklarını yönetmek için
statik panel. GitHub Pages'te yayınlanır:
<https://yakupselimucar.github.io/pomi-admin/>

Kurulumun tamamı (migration, admin ekleme, Telegram bildirimi, mağaza formları)
ana repoda: `pomi/docs/MODERATION.md`.

## Neler yapılır

- **Şikayetler:** aynı mesaja gelen şikayetler tek vakada. Açıklar en eskiden
  yeniye, 24 saat sayacıyla. İçerik bulanık gelir, dokununca açılır. Mesajın
  öncesi ve sonrası "Bağlam" ile görülür.
- **İşlemler:** ihlal yok · mesajı kaldır · gönderen yasakla (24 saat / 7 gün /
  30 gün / kalıcı, gerekçe zorunlu ve kullanıcıya gösterilir) · yasağı kaldır.
- **Duyurular:** uygulamadaki sayaç ekranının yan rayından (zil) açılan
  yenilikler sayfası. Tür (yeni özellik / güncelleme / etkinlik), TR başlık +
  metin zorunlu, EN opsiyonel; duyuru saati ileri bir tarih seçilirse o ana
  kadar gizli kalır. Push gönderilmez, okunmamış rozeti cihazda tutulur.
- **Yasaklılar**, **Kullanıcı arama** (kullanıcı adı, tam e-posta ya da kimlik)
  ve **İşlem kaydı** (1 yıl).

Oda kurucuları şikayetleri görmez; bu panel tek inceleme yeridir.

## Güvenlik modeli

Repo ve sayfa herkese açık. İçlerinde gizli bir şey yok, olmamalı da:

- Supabase URL ve **publishable** anahtar zaten mobil uygulamada yayında.
  `service_role` / secret anahtar bu repoya **asla** girmez.
- **Yetki tamamen sunucuda.** Her admin fonksiyonu `assert_app_admin()` ile
  başlar. İki şart da sağlanmalı:
  1. Kullanıcı `public.app_admins` tablosunda olmalı. Bu tabloya yalnız SQL
     editöründen yazılır; istemci ne okuyabilir ne yazabilir.
  2. Oturum 2FA ile doğrulanmış olmalı (`aal2`). Şifre sızsa bile TOTP kodu
     olmadan hiçbir veri gelmez.
- Panel admin olmayan hesabın oturumunu hemen kapatır. Oturum
  `sessionStorage`'da tutulur (sekme kapanınca biter) ve 30 dakika işlem
  yapılmazsa kapanır.
- **CSP:** yalnız kendi dosyaları, sürümü sabitlenmiş supabase-js ve Supabase
  bağlantısı. Satır içi script ya da stil yok.
- **SRI:** CDN'deki dosya değişirse tarayıcı onu çalıştırmaz.
- Kullanıcı içeriği DOM'a yalnız `textContent` ile girer (`innerHTML` yok).
- Başka bir sitenin çerçevesinde açılırsa sayfa kendini boşaltır.
- `noindex` ve `robots.txt` ile arama motorlarına kapalı.
- Telegram bildiriminde içerik ve kullanıcı adı yok (KVKK). Ayrıntı yalnız bu
  panelde, girişten sonra görülür.

> İlk girişte 2FA kurulumu `aal1` oturumla yapılır (Supabase'in modeli). Bu
> yüzden admin hesabını ekler eklemez panele girip 2FA'yı **hemen** kur.
> Doğrulanmış bir faktör olduktan sonra yenisini eklemek de `aal2` ister.

## Yerelde çalıştırma

```bash
python3 -m http.server 8080
# http://localhost:8080
```

Supabase Auth → URL Configuration'da ek bir yönlendirme adresi gerekmez: panel
e-posta + şifre kullanır, bağlantıyla giriş yok.

## supabase-js sürümünü güncelleme

1. `index.html`'deki sürümü değiştir.
2. Yeni özeti hesapla ve `integrity` alanına yaz:

   ```bash
   V=2.116.0
   curl -sL "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@$V/dist/umd/supabase.js" \
     | openssl dgst -sha384 -binary | openssl base64 -A; echo
   ```

   Başına `sha384-` ekle.
3. Yerelde giriş, 2FA ve bir listeyi aç. Hepsi çalışıyorsa yayınla.

## 2FA cihazı kaybolursa

1. Supabase panosu → Authentication → Users → hesabı aç → MFA faktörünü sil.
2. Panele gir. Yeni kurulum ekranı açılır.

# Bu klasörde migration TUTULMAZ

Veritabanı şemasının tek kaynağı **pomi** deposudur:
`pomi/supabase/migrations/`. Panel yalnız RPC çağırır, şema sahibi değildir.

Buraya bir kopya konursa iki sorun çıkar:

1. İki dosya ayrışır ve hangisinin canlıda olduğu belirsizleşir.
2. `supabase db push` bu klasörü görmez; buradaki dosya "uygulandı" sanılır
   ama aslında hiç çalışmamıştır.

`20260919213000_granular_user_bans.sql` dosyası bu yüzden buradan silinmeli:

```bash
rm migrations/20260919213000_granular_user_bans.sql
```

Güncel hâli: `pomi/supabase/migrations/20260919213000_granular_user_bans.sql`.

## Panelin bağlı olduğu RPC'ler

| RPC | Nerede tanımlı |
|---|---|
| `admin_whoami`, `admin_find_users` | pomi deposu, moderasyon göçleri |
| `admin_ban_user` (8 parametre) | `20260919213000_granular_user_bans.sql` |
| `admin_unban_user`, `admin_list_bans` | `20260919213000_granular_user_bans.sql` |
| `admin_list_reports`, `admin_resolve_reports`, `admin_message_context` | pomi deposu |

`admin_list_reports` 2026-09-22'de `reporter_names` / `reporter_count` sütunlarıyla
genişletildi (`pomi/supabase/migrations/20260922100000_report_reporter_names.sql`).
Şikayet kartındaki "Şikayet eden" alanı bu iki sütuna bakar; migration push
edilmeden panel yayınlanırsa alan boş kalır (hata vermez).
| `admin_list_announcements`, `admin_save_announcement`, `admin_delete_announcement` | pomi deposu |

Panelin yeni sürümü `admin_ban_user`'ı `p_scopes` / `p_reset_username` /
`p_close_rooms` / `p_kick_rooms` ile çağırır. **Önce migration push edilmeli,
sonra panel yayınlanmalı** — aksi hâlde yasaklama tamamen hata verir
(bilerek: eski imzaya sessizce düşmek, kapsamlı bir yasağı tam yasağa
çevirirdi).

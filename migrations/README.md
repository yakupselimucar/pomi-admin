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

Liste bilerek burada tutulmuyor: bu repo herkese açık. Güncel tablo
`pomi/docs/MODERATION.md` içinde.

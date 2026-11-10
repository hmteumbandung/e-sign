# SIGNATURE HUB HMTE UMBandung

Starter MVP React + Vite + TypeScript + Supabase untuk database pengurus/tanda tangan, arsip PDF, dan verifikasi metadata + SHA-256.

## 1. Persiapan

- Node.js 22.13+
- Akun Supabase
- GitHub repository

## 2. Jalankan lokal

```bash
npm install
cp .env.example .env
# isi VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY
npm run dev
```

## 3. Siapkan Supabase

1. Buat project di Supabase.
2. Buka SQL Editor dan jalankan `supabase/schema.sql`.
3. Buat akun admin melalui Authentication > Users.
4. Ambil UUID akun tersebut, lalu jalankan:

```sql
insert into public.profiles(id, full_name, role)
values ('UUID-AUTH-USER', 'Admin HMTE', 'super_admin');
```

5. Pastikan bucket `documents` dan `signature-files` telah dibuat oleh SQL.

## 4. Environment

Buat `.env` berdasarkan `.env.example`. `VITE_SUPABASE_ANON_KEY` adalah publishable/anon key, bukan service role key.
Jangan pernah commit file `.env`.

## 5. Deploy GitHub Pages

Tambahkan repository secret:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Buat file `.github/workflows/deploy.yml` berikut:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
        env:
          VITE_SUPABASE_URL: \${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: \${{ secrets.VITE_SUPABASE_ANON_KEY }}
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Aktifkan Settings > Pages > Source: GitHub Actions. Ubah `base` di `vite.config.ts` bila nama repository bukan `signature-hub-hmte`.

## Fitur starter yang tersedia

- Dashboard ringkasan.
- Login Supabase.
- CRUD awal tambah pengurus + upload PNG tanda tangan.
- Upload dokumen PDF dan perhitungan SHA-256 di browser.
- Verifikasi berdasarkan Verification ID dan pemeriksaan hash jika PDF diunggah.
- SQL awal untuk tabel, bucket, dan RLS.

## Penandatanganan elektronik (menu **Penandatanganan**)

1. Jalankan `supabase/esign-setup.sql` di SQL Editor (wajib; menambah kolom, trigger validasi, audit otomatis, dan kebijakan akses). Aman diulang.
2. Jalankan `npm install` agar `pdf-lib` dan `pdfjs-dist` tercatat di `package-lock.json` sebelum push (workflow memakai `npm ci` dan Node 22).
3. Alur: pilih PDF (unggah baru atau **Dari arsip**) → buat tanda tangan (gambar / unggah PNG / database pengurus) → seret tanda tangan dan blok QR ke posisi yang diinginkan (paraf tambahan di halaman lain opsional) → **Bubuhkan** → **Unduh PDF** atau **Simpan ke arsip**.
4. Footer verifikasi pada PDF berisi QR + kode singkat 10 karakter di kiri dan teks keterangan yang dapat diubah di kanan (lihat bagian *Footer QR verifikasi*). Verification ID dan SHA-256 dokumen asli tetap tertanam sebagai teks tak kasatmata yang dapat dicari. SHA-256 PDF akhir disimpan di kolom `sha256`; halaman **Verifikasi** membandingkannya dengan PDF yang diunggah. QR membuka `#/verifikasi?id=...`.
5. Opsional: isi `VITE_PUBLIC_URL` (mis. `https://namaorg.github.io/signature-hub-hmte`) agar QR selalu menunjuk ke alamat publik.

### Peran dan persetujuan

| Peran | Hak |
|---|---|
| Sekretaris | Mengunggah, mengedit, dan menghapus dokumen yang belum ditandatangani, serta **menugaskan penandatangan** di Manajemen Dokumen. Tidak dapat menandatangani. |
| Penandatangan (`signer`) | Hanya menandatangani dokumen `pending` yang ditugaskan kepadanya (Penandatanganan → Dari arsip). Tidak dapat mengubah nomor/perihal. |
| Admin / Super Admin | Menandatangani dokumen apa pun, memakai tanda tangan pengurus mana pun, **mencabut** dokumen, melihat Riwayat Aktivitas, menghubungkan pengurus ke akun. |

- Penugasan memakai kolom `signature_owners.user_id` (menu Database Pengurus, kolom **Akun login**, khusus admin). File tanda tangan di storage hanya dapat dibaca admin dan pemiliknya.
- Dokumen `verified` tidak dapat diubah; hanya admin yang dapat mencabutnya (alasan wajib) dan pencabutan bersifat final. Aturan ini ditegakkan oleh trigger database, bukan hanya aplikasi.
- Riwayat aktivitas (unggah, tanda tangan, pencabutan) dicatat otomatis oleh trigger database.

### Manajemen dokumen dan notifikasi

- **Edit:** admin dan sekretaris dapat mengubah nomor surat, perihal, penandatangan, dan mengganti file PDF selama dokumen belum ditandatangani. Verification ID tidak berubah. Perubahan tercatat di Riwayat Aktivitas.
- **Hapus:** dokumen belum ditandatangani dapat dihapus admin dan sekretaris (file PDF ikut dihapus). Dokumen `verified` atau `revoked` hanya dapat dihapus **admin** lewat **Hapus permanen** (lihat bagian di bawah); sekretaris dan penandatangan tetap hanya bisa memakai **Cabut**. Aturan ini ditegakkan oleh trigger database.
- **Notifikasi:** penandatangan melihat badge di menu Penandatanganan, ikon lonceng, panel di Dashboard, penanda "Perlu TTE Anda" di tabel, toast untuk dokumen baru, dan jumlah di judul tab. Admin dan sekretaris melihat semua dokumen yang belum ditandatangani. Daftar diperbarui otomatis tiap 60 detik dan saat tab kembali aktif. Notifikasi ini hanya muncul saat aplikasi terbuka; email/push belum tersedia.

Semua pemrosesan PDF dan hash berjalan di browser. Ini tanda tangan gambar + bukti integritas, bukan tanda tangan digital tersertifikasi (lihat batasan di bawah). Database tidak dapat menghitung ulang hash isi file di storage; untuk itu diperlukan Edge Function.

## Batasan dan catatan keamanan

- Ini starter/MVP, belum sistem produksi lengkap.
- Role admin harus ditetapkan secara manual oleh pengelola database.
- Tabel metadata dokumen dapat dibaca publik untuk verifikasi; jangan menyimpan data sensitif di kolom yang terekspos.
- PDF dan gambar tanda tangan disimpan di private bucket.
- Integrasi PSrE / tanda tangan kriptografis PAdES dan persetujuan berlapis (lebih dari satu penandatangan) belum tersedia.
- Gambar tanda tangan yang ditempel ke PDF bukan tanda tangan digital tersertifikasi. Untuk dokumen resmi yang membutuhkan jaminan identitas dan non-repudiation, integrasikan PSrE dan validasi sertifikat.
- Sebelum produksi, audit ulang seluruh RLS, kebijakan storage, alur persetujuan, dan perlindungan data pribadi.

## Registrasi dan aktivasi akun (fitur tambahan)

1. Jalankan `supabase/schema.sql` (jika belum pernah dijalankan), lalu jalankan `supabase/account-setup.sql` melalui **Supabase → SQL Editor**.
2. Pastikan provider Email aktif di **Authentication → Sign In / Providers**.
3. Buka website dan pilih **Login → Daftar di sini** atau kunjungi `/daftar`.
4. Isi nama, NIM, email, dan password minimal 8 karakter. Jika konfirmasi email aktif, pengguna harus mengonfirmasi email terlebih dahulu.
5. Setiap akun baru otomatis memperoleh role `viewer` dan status `pending`. Email dan NIM disimpan pada profil akun. Akun belum dapat login sampai disetujui.
6. Untuk membuat Super Admin pertama: daftarkan akun melalui halaman website, lalu di SQL Editor jalankan query bootstrap pada bagian akhir `supabase/account-setup.sql` setelah mengganti email contoh dengan email akun tersebut. Jalankan query ini hanya untuk akun pengelola yang dipercaya.
7. Login sebagai Super Admin. Menu **Manajemen Akun** akan muncul. Dari sana Super Admin dapat mengaktifkan/menonaktifkan akun dan menetapkan role.

Role yang tersedia: `super_admin`, `admin`, `secretary`, `signer`, dan `viewer`. Registrasi publik tidak dapat memilih role atau mengaktifkan akun sendiri.

**Catatan keamanan:** jangan pernah menaruh Supabase `service_role` key di file `.env` frontend. Jalankan SQL bootstrap hanya melalui dashboard Supabase yang dimiliki pengelola project.


## Pembaruan fitur (jalankan SQL terbaru)

Urutan SQL di **Supabase → SQL Editor**: `schema.sql` → `account-setup.sql` → `esign-setup.sql` (**versi terbaru, jalankan ulang**) → `features-setup.sql` (baru). Semuanya aman diulang.

### Footer QR verifikasi
- Blok footer lebar penuh: QR + kode singkat (10 karakter, mis. `8F573B89BC`) di kiri, teks keterangan rata tengah di kanan. Latar transparan.
- Di menu **Penandatanganan → langkah 3**: teks footer dapat diedit, ukuran huruf menyesuaikan otomatis agar muat, tombol **Rapatkan footer ke bawah halaman**, opsi **footer di semua halaman**, **Simpan sebagai default** (tersimpan di browser) dan **Teks bawaan**.
- Placeholder teks: `{penandatangan}` `{jabatan}` `{waktu}` `{kode}` `{nomor}`.
- Kode singkat dapat dimasukkan di halaman **Verifikasi** sebagai pengganti Verification ID lengkap (kolom `short_code`).
- Teks bawaan **tidak** menyebut sertifikat BSrE/PSrE karena sistem ini tidak memakainya. Jangan menambahkan klaim tersebut pada teks footer kecuali sistem benar-benar terintegrasi dengan PSrE.

### Akun Saya (`#/profil`)
Ubah nama dan NIM, ganti email (konfirmasi via email), ganti password (memverifikasi password lama), keluar dari semua perangkat, dan hapus akun (konfirmasi password + ketik `HAPUS`). Halaman login memiliki **Lupa password** (tautan email). Agar tautan pemulihan dan konfirmasi email membuka aplikasi, tambahkan alamat situs Anda di **Supabase → Authentication → URL Configuration → Redirect URLs** (mis. `https://namaorg.github.io/signature-hub-hmte/`).
- Menghapus akun tidak menghapus dokumen yang pernah ditandatangani; referensinya dikosongkan dan nama pelaku disimpan di Riwayat Aktivitas.
- Super Admin terakhir tidak dapat dihapus. Super Admin dapat menghapus akun lain di **Manajemen Akun**.

### Kelompok surat
Di **Manajemen Dokumen**: buat/ubah/hapus kelompok (nama, warna, keterangan), filter per kelompok, pindahkan satu surat lewat dropdown atau banyak surat sekaligus (centang lalu **Terapkan**). Menghapus kelompok tidak menghapus surat. Kelompok juga dapat dipilih saat unggah, edit, dan penandatanganan.

### Hapus surat terverifikasi
Khusus admin: tombol **Hapus permanen** pada dokumen `verified`/`revoked`. Wajib alasan dan mengetik `HAPUS`; alasan tercatat di Riwayat Aktivitas, file PDF asli dan bertanda tangan ikut dihapus. Setelah dihapus, QR pada salinan yang sudah beredar akan menampilkan "Dokumen tidak ditemukan". Bila tujuannya hanya membatalkan keabsahan, gunakan **Cabut**.

### Hapus data pengurus dan tanda tangan
Khusus admin. **Database Pengurus**: hapus satu atau banyak pengurus (beserta file tanda tangannya). **Database Tanda Tangan**: hapus file tanda tangan saja (data pengurus tetap), serta **Unggah/Ganti** file. Dokumen yang sudah ditandatangani tidak terpengaruh. Penghapusan tercatat di Riwayat Aktivitas.


## Pembaruan v3: alur persetujuan, penomoran, verifikasi, surat masuk

Urutan SQL (SQL Editor): `schema.sql` → `account-setup.sql` → `esign-setup.sql` (terbaru) → `features-setup.sql` → `workflow-setup.sql` (baru). Jangan menjalankan ulang `schema.sql` setelah `workflow-setup.sql` (policy baca publik lama akan terpasang lagi).

### Alur persetujuan
- **Banyak penandatangan** (1 sampai 8, berurutan atau bebas urutan) diatur saat unggah dan di Edit dokumen. Tiap penandatangan membubuhkan tanda tangannya; **footer QR dipasang penandatangan terakhir** dan memuat semua nama (`{penandatangan}`). Dokumen menjadi *Terverifikasi* setelah semua selesai. Penyimpanan tiap langkah dikunci di database (hash PDF harus sama dengan versi terakhir), jadi dua orang yang menandatangani bersamaan tidak saling menimpa; yang kedua diminta memuat ulang.
- **Tolak / kembalikan dengan catatan:** tombol di menu Penandatanganan (penandatangan yang ditugaskan atau admin). Status menjadi *Ditolak*, catatan tampil di Manajemen Dokumen. Sekretaris menekan **Revisi**, mengunggah file revisi (opsional), lalu **Simpan & ajukan ulang**: tanda tangan lama dibuang dan alur mulai dari awal (nomor revisi bertambah).
- **Tautan permintaan tanda tangan:** buka **Detail** dokumen, lalu kirim lewat WhatsApp (nomor HP diisi di Edit pengurus) atau email, atau salin tautannya. Penerima harus login.
- **Notifikasi otomatis (opsional, belum teruji):** email/WhatsApp tanpa klik manual memerlukan layanan luar. Kode siap pakai ada di `supabase/functions/notify-signers`: (1) aktifkan ekstensi `pg_net` di Database → Extensions, (2) `supabase functions deploy notify-signers --no-verify-jwt` dan atur secrets (`NOTIFY_SECRET`, `APP_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `FONNTE_TOKEN`), (3) isi tabel rahasia lewat SQL Editor:
  ```sql
  insert into public.private_settings(key, value) values
    ('notify_url', 'https://PROJECT_REF.supabase.co/functions/v1/notify-signers'),
    ('notify_secret', 'ISI_SAMA_DENGAN_NOTIFY_SECRET')
  on conflict (key) do update set value = excluded.value;
  ```
  Pengingat berkala (opsional) dapat dijadwalkan dengan `pg_cron` memanggil fungsi yang sama dengan body `{"type":"reminder","days":3}`. Tanpa langkah ini, pengingat tetap muncul di aplikasi (lonceng, dashboard, penanda "Tertunda N hari").

### Penomoran otomatis
Nomor surat terisi otomatis dan dapat diubah manual. Format dan reset (bulanan/tahunan/tidak pernah) diatur admin di **Pengaturan**, dan dapat dibedakan per kelompok surat (kode, format, reset). Token: `{no} {bulan} {bulan_romawi} {tahun} {kode}`. Nomor diambil secara atomik saat disimpan, jadi tidak ada nomor ganda atau terlewat; nomor yang sudah dipakai ditolak database.

### Verifikasi
Halaman Verifikasi kini memakai fungsi `verify_document`, sehingga tabel dokumen **tidak lagi dapat dibaca anonim**. Halaman menampilkan penandatangan beserta waktunya, pratinjau PDF, unduhan dokumen asli, dan pemindai QR dengan kamera (Chrome/Edge/Android; di browser lain pakai kamera bawaan ponsel). Setiap pemeriksaan dicatat; admin melihat jumlahnya di **Detail** dokumen. Pratinjau/unduhan publik dapat dimatikan per dokumen (kotak centang di Detail); dokumen yang masih bisa diunduh publik dapat diunduh siapa pun yang memegang QR atau kodenya. Jumlah verifikasi dapat digelembungkan siapa pun yang tahu kode, jadi dipakai sebagai petunjuk, bukan bukti.

### Lainnya
- **Surat masuk & disposisi:** menu baru (admin, sekretaris, penandatangan). Penerima disposisi dapat memperbarui status dan tanggapan.
- **Pengurus:** edit data, nonaktifkan/arsipkan (tanda tangan tidak dapat dipakai lagi), arsipkan satu periode, impor Excel/CSV (templat tersedia di dialog impor), ekspor.
- **Ekspor Excel/CSV** untuk dokumen, pengurus, surat masuk, dan riwayat aktivitas; **unduh banyak PDF sebagai ZIP** (centang dokumen).
- **Footer QR:** bawaan 17 × 2 cm di tengah bawah halaman; lebar dan tinggi dapat diatur dalam cm. Teks footer dapat disimpan sebagai **default tim** (admin/sekretaris).
- **Dashboard:** grafik surat per bulan dan daftar dokumen yang menunggu terlalu lama. **Mode gelap** dan perbaikan tampilan ponsel.

/** Alamat dasar aplikasi (untuk tautan yang dibagikan). Dapat dipaksa lewat VITE_PUBLIC_URL. */
export function appBaseUrl() {
  const fixed = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.trim();
  if (fixed) return fixed.replace(/\/+$/, '') + '/';
  return window.location.origin + import.meta.env.BASE_URL;
}

export const signLink = (docId: string) => `${appBaseUrl()}#/penandatanganan?doc=${encodeURIComponent(docId)}`;
export const verifyLink = (verificationId: string) => `${appBaseUrl()}#/verifikasi?id=${encodeURIComponent(verificationId)}`;

/** Normalisasi nomor telepon Indonesia ke format internasional tanpa "+" untuk wa.me. */
export function waNumber(phone?: string | null) {
  const d = (phone || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('62')) return d;
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (d.startsWith('8')) return '62' + d;
  return d;
}

export function waLink(phone: string | null | undefined, text: string) {
  const n = waNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export function mailLink(to: string | null | undefined, subject: string, body: string) {
  return `mailto:${to || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function signRequestText(opts: { name?: string | null; number: string; title: string; url: string }) {
  return `Yth. ${opts.name || 'Bapak/Ibu'},\n\nMohon tanda tangan elektronik untuk dokumen:\n${opts.number} - ${opts.title}\n\nBuka tautan berikut (login terlebih dahulu):\n${opts.url}\n\nTerima kasih.\nSIGNATURE HUB HMTE UMBandung`;
}

export const CM = 28.3465; // poin PDF per sentimeter

import { PDFDocument, StandardFonts, degrees, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

export type Placement = {
  /** Nomor halaman, mulai dari 1 */
  page: number;
  /** Posisi pojok kiri-atas sebagai pecahan lebar/tinggi halaman (sebagaimana tampil di layar) */
  sig: { x: number; y: number; w: number };
  qr: { x: number; y: number; w: number } | null;
  /** pasang blok QR footer di semua halaman (posisi relatif sama) */
  qrAllPages?: boolean;
  /** rasio tinggi / lebar blok footer (bawaan: 2 cm / 17 cm) */
  qrAspect?: number;
  /** tanda tangan/paraf tambahan pada halaman lain (atau halaman yang sama) */
  extras?: { page: number; x: number; y: number; w: number }[];
};

export type StampInfo = {
  verificationId: string;
  verifyUrl: string;
  signerName: string;
  signerPosition: string;
  originalSha256: string;
  signedAt: Date;
  /** seluruh penandatangan dokumen (bila lebih dari satu) untuk placeholder {penandatangan} */
  signers?: { name: string; position: string }[];
  /** nomor surat (opsional, untuk placeholder {nomor}) */
  documentNumber?: string;
  /** templat teks footer; placeholder: {penandatangan} {jabatan} {waktu} {kode} {nomor} */
  footerText?: string;
};

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** URL halaman verifikasi yang dikodekan ke dalam QR. VITE_PUBLIC_URL (opsional) menimpa origin saat ini. */
export function buildVerifyUrl(verificationId: string) {
  const configured = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.trim();
  const base = configured
    ? configured.replace(/\/+$/, '') + '/'
    : `${window.location.origin}${import.meta.env.BASE_URL}`;
  return `${base}#/verifikasi?id=${encodeURIComponent(verificationId)}`;
}

export function formatSignedAt(d: Date) {
  const s = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${s.replace('.', ':')} WIB`;
}

/** Kode singkat 10 karakter (huruf besar) yang tampil di bawah QR. Harus sama dengan kolom short_code di database. */
export function shortCode(verificationId: string) {
  return verificationId.replace(/-/g, '').slice(0, 10).toUpperCase();
}

export const DEFAULT_FOOTER_TEXT =
  'Dokumen ini telah ditandatangani secara elektronik oleh {penandatangan} ({jabatan}) pada {waktu} menggunakan SIGNATURE HUB HMTE UMBandung. ' +
  'Keaslian dokumen dapat diperiksa dengan memindai QR Code atau memasukkan kode di bawah QR pada halaman Verifikasi Dokumen.';

/** Mengisi placeholder pada templat teks footer. */
export function resolveFooterText(template: string | undefined, info: StampInfo) {
  const t = (template && template.trim()) || DEFAULT_FOOTER_TEXT;
  const multi = (info.signers?.length || 0) > 1;
  const names = multi
    ? info.signers!.map((x) => (x.position ? `${x.name} (${x.position})` : x.name)).reduce((acc, cur, i, arr) => (i === 0 ? cur : i === arr.length - 1 ? `${acc} dan ${cur}` : `${acc}, ${cur}`), '')
    : info.signerName || '';
  return t
    .replace(/\{penandatangan\}/gi, names)
    .replace(/\{jabatan\}/gi, multi ? '' : info.signerPosition || '')
    .replace(/\{waktu\}/gi, formatSignedAt(info.signedAt))
    .replace(/\{kode\}/gi, shortCode(info.verificationId))
    .replace(/\{nomor\}/gi, info.documentNumber || '')
    .replace(/\s*\(\s*\)/g, '') // "( )" akibat placeholder kosong
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Ukuran bawaan footer: lebar 17 cm, tinggi 2 cm (rasio dipakai agar pratinjau = hasil akhir). */
export const QR_DEFAULT_W_CM = 17;
export const QR_DEFAULT_H_CM = 2;
export const QR_BLOCK_ASPECT = QR_DEFAULT_H_CM / QR_DEFAULT_W_CM;
const BLOCK_W = 1600; // piksel kanvas

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Menggambar blok verifikasi footer: QR + kode singkat di kiri, teks keterangan (dapat diubah) di kanan.
 * Latar transparan, sehingga menyatu dengan kertas. Ukuran huruf mengecil otomatis agar teks muat.
 */
export async function renderQrBlock(info: StampInfo, aspect: number = QR_BLOCK_ASPECT): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  const W = BLOCK_W, H = Math.max(110, Math.round(BLOCK_W * aspect));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);

  // Kolom kiri: QR + kode di bawahnya. Ukuran menyesuaikan tinggi blok.
  const codeFont = Math.max(16, Math.min(30, Math.round(H * 0.14)));
  const codeH = codeFont + 10;
  const qrSize = Math.max(60, Math.min(H - codeH - 8, Math.round(W * 0.28)));
  const qrX = 10, qrY = 4;
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, info.verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: qrSize, color: { dark: '#000000', light: '#ffffff' } });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `400 ${codeFont}px Arial, "DM Sans", sans-serif`;
  ctx.fillText(shortCode(info.verificationId), qrX + qrSize / 2, qrY + qrSize + codeFont + 2);

  // Kolom kanan: teks keterangan rata tengah; huruf mengecil otomatis agar muat.
  const tx = qrX + qrSize + 56;
  const tw = W - tx - 24;
  const text = resolveFooterText(info.footerText, info);
  const pad = 8;
  let size = Math.min(44, Math.round(H * 0.22)), lines: string[] = [];
  for (; size >= 11; size--) {
    ctx.font = `400 ${size}px Arial, "DM Sans", sans-serif`;
    lines = wrapLines(ctx, text, tw);
    if (lines.length * size * 1.35 <= H - pad * 2) break;
  }
  const lh = size * 1.35;
  let y = (H - lines.length * lh) / 2 + size * 1.02;
  ctx.fillStyle = '#000000';
  for (const l of lines) { ctx.fillText(l, tx + tw / 2, y); y += lh; }

  const dataUrl = canvas.toDataURL('image/png');
  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, dataUrl };
}

type Box = { x: number; y: number; width: number; height: number };

/** Mengubah titik pada tampilan (asal kiri-atas, sudah memperhitungkan rotasi halaman) ke koordinat ruang halaman PDF. */
function visualToPdf(xv: number, yv: number, rot: number, box: Box) {
  const W = box.width, H = box.height;
  switch (rot) {
    case 90: return { x: box.x + yv, y: box.y + xv };
    case 180: return { x: box.x + W - xv, y: box.y + yv };
    case 270: return { x: box.x + W - yv, y: box.y + H - xv };
    default: return { x: box.x + xv, y: box.y + H - yv };
  }
}

export type StampResult = { bytes: Uint8Array; sha256: string; pageCount: number };

export async function stampPdf(
  original: Uint8Array,
  signature: { bytes: Uint8Array; width: number; height: number },
  qrBlock: { bytes: Uint8Array } | null,
  placement: Placement,
  info: StampInfo,
): Promise<StampResult> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(original);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/encrypt/i.test(msg)) throw new Error('PDF terenkripsi/diproteksi sehingga tidak dapat ditandatangani. Hapus proteksi terlebih dahulu.');
    throw new Error('PDF tidak dapat diproses: ' + msg);
  }
  const pages = pdf.getPages();
  const mainPage = pages[placement.page - 1];
  if (!mainPage) throw new Error('Halaman yang dipilih tidak ada.');

  const geometry = (page: PDFPage) => {
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const box = page.getCropBox();
    const sideways = rot === 90 || rot === 270;
    return { rot, box, visW: sideways ? box.height : box.width, visH: sideways ? box.width : box.height };
  };

  const embedded = new Map<Uint8Array, PDFImage>();

  /** Menggambar PNG pada tampilan halaman dan mengembalikan asal (kiri-bawah) + rotasi untuk teks pendamping. */
  const draw = async (page: PDFPage, png: Uint8Array, p: { x: number; y: number; w: number }, aspect: number) => {
    const { rot, box, visW, visH } = geometry(page);
    let img = embedded.get(png);
    if (!img) { img = await pdf.embedPng(png); embedded.set(png, img); } // satu salinan gambar per berkas
    const w = p.w * visW;
    const h = w * aspect;
    const origin = visualToPdf(p.x * visW, p.y * visH + h, rot, box); // pojok kiri-bawah gambar pada tampilan
    page.drawImage(img, { x: origin.x, y: origin.y, width: w, height: h, rotate: degrees(rot) });
    return { origin, rot, w, h };
  };

  const sigAspect = signature.height / signature.width;
  await draw(mainPage, signature.bytes, placement.sig, sigAspect);
  for (const ex of placement.extras ?? []) {
    const pg = pages[ex.page - 1];
    if (pg) await draw(pg, signature.bytes, ex, sigAspect);
  }

  if (qrBlock && placement.qr) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const safe = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    const footer = safe(resolveFooterText(info.footerText, info));
    const textLines: string[] = [];
    for (let i = 0; i < footer.length; i += 110) textLines.push(footer.slice(i, i + 110));
    textLines.push(
      safe(`Kode: ${shortCode(info.verificationId)}`),
      safe(`ID Verifikasi: ${info.verificationId}`),
      safe(`SHA-256 dokumen asli: ${info.originalSha256}`),
    );
    const targets = placement.qrAllPages ? pages : [mainPage];
    for (const pg of targets) {
      const q = await draw(pg, qrBlock.bytes, placement.qr, placement.qrAspect ?? QR_BLOCK_ASPECT);
      // Lapisan teks tak kasatmata supaya isi blok dapat dicari/disalin dan dibaca pembaca layar.
      const c = Math.cos((q.rot * Math.PI) / 180), sn = Math.sin((q.rot * Math.PI) / 180);
      textLines.forEach((text, i) => {
        const dx = q.w * 0.2, dy = q.h * 0.9 - i * 6; // koordinat lokal (kanan, atas) dari pojok kiri-bawah blok
        pg.drawText(text, { x: q.origin.x + dx * c - dy * sn, y: q.origin.y + dx * sn + dy * c, size: 5, font, opacity: 0, rotate: degrees(q.rot) });
      });
    }
  }

  pdf.setProducer('SIGNATURE HUB HMTE UMBandung');
  pdf.setSubject(`Ditandatangani elektronik. ID Verifikasi: ${info.verificationId}`);
  pdf.setKeywords([`verification-id:${info.verificationId}`, `original-sha256:${info.originalSha256}`]);
  pdf.setModificationDate(info.signedAt);

  const bytes = await pdf.save();
  return { bytes, sha256: await sha256Hex(bytes), pageCount: pages.length };
}

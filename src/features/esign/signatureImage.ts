// Utilitas gambar tanda tangan: pangkas area kosong, hapus latar putih, konversi ke bytes PNG.

export type SignatureAsset = {
  bytes: Uint8Array;
  dataUrl: string;
  width: number;
  height: number;
};

export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // sama dengan batas bucket signature-files

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isPng(bytes: Uint8Array) {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** Pangkas piksel transparan di sekeliling goresan. Mengembalikan null bila kanvas kosong. */
export function trimCanvas(src: HTMLCanvasElement, padding = 6): HTMLCanvasElement | null {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x0 = Math.max(0, minX - padding), y0 = Math.max(0, minY - padding);
  const x1 = Math.min(width, maxX + 1 + padding), y1 = Math.min(height, maxY + 1 + padding);
  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function canvasToAsset(canvas: HTMLCanvasElement): SignatureAsset {
  const dataUrl = canvas.toDataURL('image/png');
  return { bytes: dataUrlToBytes(dataUrl), dataUrl, width: canvas.width, height: canvas.height };
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar tidak dapat dibaca.'));
    img.src = url;
  });
}

export type UploadResult = { asset: SignatureAsset; hadTransparency: boolean };

/**
 * Memproses PNG yang diunggah. Bila `removeWhite` aktif, piksel putih/hampir putih dijadikan transparan.
 * Hasil selalu dipangkas supaya posisi tanda tangan presisi.
 */
export async function processUploadedPng(file: File, removeWhite: boolean): Promise<UploadResult> {
  if (file.size > MAX_SIGNATURE_BYTES) throw new Error('Ukuran file maksimal 2 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPng(bytes)) throw new Error('File harus berformat PNG.');
  return processPngBytes(bytes, removeWhite);
}

export async function processPngBytes(bytes: Uint8Array, removeWhite: boolean): Promise<UploadResult> {
  const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
  try {
    const img = await loadImage(blobUrl);
    const maxSide = 1600; // batasi ukuran agar PDF tidak membengkak
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    let hadTransparency = false;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 250) { hadTransparency = true; break; }
    }
    if (removeWhite) {
      for (let i = 0; i < px.length; i += 4) {
        const min = Math.min(px[i], px[i + 1], px[i + 2]);
        if (min >= 245) px[i + 3] = 0;
        else if (min > 200) px[i + 3] = Math.round(px[i + 3] * (245 - min) / 45); // tepi halus
      }
      ctx.putImageData(imageData, 0, 0);
    }
    const trimmed = trimCanvas(canvas);
    if (!trimmed) throw new Error('Gambar tampak kosong atau seluruhnya transparan/putih.');
    return { asset: canvasToAsset(trimmed), hadTransparency };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

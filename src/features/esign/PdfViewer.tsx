import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Move } from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type OverlayItem = {
  id: string;
  /** halaman tempat item tampil */
  page: number;
  label: string;
  src: string;
  /** tinggi / lebar gambar */
  aspect: number;
  /** pojok kiri-atas & lebar sebagai pecahan dari ukuran halaman */
  x: number;
  y: number;
  w: number;
  minW: number;
  maxW: number;
};

type Props = {
  data: Uint8Array | null;
  page: number;
  onPageChange: (p: number) => void;
  onLoaded?: (numPages: number) => void;
  /** rasio lebar / tinggi halaman yang sedang tampil */
  onAspect?: (ratio: number) => void;
  items?: OverlayItem[];
  onItemChange?: (id: string, patch: { x?: number; y?: number; w?: number }) => void;
};

const MAX_CSS_WIDTH = 940;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export default function PdfViewer({ data, page, onPageChange, onLoaded, onAspect, items = [], onItemChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<pdfjs.RenderTask | null>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [avail, setAvail] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onAspectRef = useRef(onAspect);
  onAspectRef.current = onAspect;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Muat dokumen. Salinan data diberikan ke worker karena buffer-nya akan "dipindahkan".
  useEffect(() => {
    setError('');
    if (!data) { setDoc(null); setNumPages(0); return; }
    let cancelled = false;
    setLoading(true);
    const task = pdfjs.getDocument({ data: data.slice() });
    task.promise.then(
      (d) => {
        if (cancelled) return;
        setDoc(d);
        setNumPages(d.numPages);
        onLoadedRef.current?.(d.numPages);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setDoc(null);
        setNumPages(0);
        setLoading(false);
        setError(e?.name === 'PasswordException' ? 'PDF dilindungi kata sandi dan tidak dapat dibuka.' : 'PDF tidak dapat dibaca. Pastikan file tidak rusak.');
      },
    );
    return () => { cancelled = true; task.destroy(); };
  }, [data]);

  // Gambar halaman aktif
  useEffect(() => {
    if (!doc || !avail || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(clamp(page, 1, doc.numPages));
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const cssW = Math.min(avail, MAX_CSS_WIDTH);
      const scale = cssW / base.width;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const viewport = p.getViewport({ scale: scale * dpr });
      const canvas = canvasRef.current!;
      if (taskRef.current) {
        taskRef.current.cancel();
        try { await taskRef.current.promise; } catch { /* dibatalkan */ }
      }
      if (cancelled) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      setSize({ w: cssW, h: (base.height * cssW) / base.width });
      onAspectRef.current?.(base.width / base.height);
      const task = p.render({ canvas, viewport });
      taskRef.current = task;
      try { await task.promise; } catch (e: any) { if (e?.name !== 'RenderingCancelledException') setError('Gagal menampilkan halaman.'); }
    })().catch((e) => {
      // dokumen dihancurkan saat berganti berkas: bukan kesalahan bagi pengguna
      if (!cancelled && e?.message !== 'Transport destroyed') setError('Gagal menampilkan halaman.');
    });
    return () => { cancelled = true; };
  }, [doc, page, avail]);

  useEffect(() => () => { taskRef.current?.cancel(); }, []);

  const pageItems = items.filter((i) => i.page === page);

  return (
    <div className="pdfv" ref={wrapRef}>
      {doc && (
        <div className="pdfv-bar">
          <button type="button" className="icon-btn" aria-label="Halaman sebelumnya" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={18} /></button>
          <span>Halaman <b>{page}</b> dari {numPages}</span>
          <button type="button" className="icon-btn" aria-label="Halaman berikutnya" disabled={page >= numPages} onClick={() => onPageChange(page + 1)}><ChevronRight size={18} /></button>
        </div>
      )}
      {!data && <div className="pdfv-empty">Pilih berkas PDF untuk melihat pratinjau dokumen.</div>}
      {loading && <div className="pdfv-empty">Memuat dokumen…</div>}
      {error && <div className="pdfv-empty error">{error}</div>}
      <div className="pdfv-page" style={{ width: size.w || undefined, height: size.h || undefined, display: doc && !error ? 'block' : 'none' }}>
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
        {pageItems.map((it) => (
          <Draggable key={it.id} item={it} pageW={size.w} pageH={size.h} onChange={(patch) => onItemChange?.(it.id, patch)} />
        ))}
      </div>
    </div>
  );
}

function Draggable({ item, pageW, pageH, onChange }: { item: OverlayItem; pageW: number; pageH: number; onChange: (p: { x?: number; y?: number; w?: number }) => void }) {
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; x: number; y: number; w: number } | null>(null);
  const hFrac = (w: number) => (w * pageW * item.aspect) / pageH;

  function start(e: React.PointerEvent, mode: 'move' | 'resize') {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, x: item.x, y: item.y, w: item.w };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !pageW || !pageH) return;
    const dx = (e.clientX - d.sx) / pageW;
    const dy = (e.clientY - d.sy) / pageH;
    if (d.mode === 'move') {
      onChange({ x: clamp(d.x + dx, 0, 1 - item.w), y: clamp(d.y + dy, 0, Math.max(0, 1 - hFrac(item.w))) });
    } else {
      const maxByEdge = Math.min(item.maxW, 1 - d.x, ((1 - d.y) * pageH) / (pageW * item.aspect));
      onChange({ w: clamp(d.w + dx, item.minW, Math.max(item.minW, maxByEdge)) });
    }
  }
  function end() { drag.current = null; }
  function key(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 0.02 : 0.005;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    onChange({ x: clamp(item.x + v[0], 0, 1 - item.w), y: clamp(item.y + v[1], 0, Math.max(0, 1 - hFrac(item.w))) });
  }

  return (
    <div
      className="ovl"
      tabIndex={0}
      role="group"
      aria-label={`${item.label}. Seret atau gunakan tombol panah untuk memindahkan.`}
      style={{ left: item.x * pageW, top: item.y * pageH, width: item.w * pageW, height: item.w * pageW * item.aspect }}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={key}
    >
      <img src={item.src} alt="" draggable={false} />
      <span className="ovl-tag"><Move size={11} />{item.label}</span>
      <span className="ovl-handle" aria-hidden onPointerDown={(e) => start(e, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
    </div>
  );
}

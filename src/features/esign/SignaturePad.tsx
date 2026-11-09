import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Undo2 } from 'lucide-react';
import { canvasToAsset, trimCanvas, type SignatureAsset } from './signatureImage';

type Point = { x: number; y: number; p: number };
type Stroke = Point[];

const COLORS = [['#111111', 'Hitam'], ['#1d3a8a', 'Biru tua']] as const;

/** Kanvas gambar tanda tangan (mouse, stylus, atau sentuhan). Hasil: PNG transparan yang sudah dipangkas. */
export default function SignaturePad({ onUse }: { onUse: (asset: SignatureAsset) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState<string>(COLORS[0][0]);
  const [width, setWidth] = useState(3);
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState('');

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = canvas.width / canvas.clientWidth;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    const all = current.current ? [...strokes.current, current.current] : strokes.current;
    for (const s of all) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(s[0].x, s[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.beginPath();
        ctx.lineWidth = width * (0.6 + 0.8 * (b.p || 0.5));
        ctx.moveTo(i === 1 ? a.x : (s[i - 2].x + a.x) / 2, i === 1 ? a.y : (s[i - 2].y + a.y) / 2);
        ctx.quadraticCurveTo(a.x, a.y, mid.x, mid.y);
        ctx.stroke();
      }
    }
  }, [color, width]);

  // Sesuaikan resolusi kanvas dengan ukuran tampil + devicePixelRatio
  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(redraw, [redraw]);

  function pos(e: React.PointerEvent): Point {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'pen' ? e.pressure : 0.5 };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = [pos(e)];
    setError('');
    redraw();
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!current.current) return;
    const native = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = native.length ? native : [e.nativeEvent];
    const r = canvasRef.current!.getBoundingClientRect();
    for (const ev of events) {
      current.current.push({ x: ev.clientX - r.left, y: ev.clientY - r.top, p: ev.pointerType === 'pen' ? ev.pressure : 0.5 });
    }
    redraw();
  }
  function up() {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    setEmpty(false);
    redraw();
  }
  function clear() {
    strokes.current = [];
    current.current = null;
    setEmpty(true);
    setError('');
    redraw();
  }
  function undo() {
    strokes.current.pop();
    setEmpty(strokes.current.length === 0);
    redraw();
  }
  function use() {
    const trimmed = trimCanvas(canvasRef.current!, 8 * (canvasRef.current!.width / canvasRef.current!.clientWidth));
    if (!trimmed) { setError('Gambar tanda tangan terlebih dahulu.'); return; }
    onUse(canvasToAsset(trimmed));
  }

  return (
    <div className="sigpad">
      <div className="sigpad-surface">
        <canvas
          ref={canvasRef}
          className="sigpad-canvas"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="Area menggambar tanda tangan"
        />
        {empty && <span className="sigpad-hint">Gambar tanda tangan di sini</span>}
        <span className="sigpad-baseline" />
      </div>
      <div className="sigpad-tools">
        <div className="sigpad-colors" role="group" aria-label="Warna tinta">
          {COLORS.map(([c, label]) => (
            <button type="button" key={c} title={label} aria-label={label} aria-pressed={color === c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <label className="sigpad-width">Tebal
          <input type="range" min={2} max={7} step={0.5} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <button type="button" className="button ghost" onClick={undo} disabled={empty}><Undo2 size={15} />Urungkan</button>
        <button type="button" className="button ghost" onClick={clear} disabled={empty}><Eraser size={15} />Hapus</button>
      </div>
      {error && <p className="error">{error}</p>}
      <button type="button" className="button primary" onClick={use} disabled={empty}>Gunakan tanda tangan ini</button>
    </div>
  );
}

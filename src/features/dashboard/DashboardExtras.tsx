import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { Clock, MessageCircle } from 'lucide-react';
import { signLink, signRequestText, waLink } from '../../lib/appUrl';
import type { Doc, DocSigner, Signer } from '../../types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const dayMs = 86400000;

/** Grafik batang jumlah surat per bulan (12 bulan terakhir): terverifikasi vs lainnya. SVG murni tanpa pustaka. */
export function MonthlyChart({ docs }: { docs: Doc[] }) {
  const data = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTHS[d.getMonth()], year: d.getFullYear(), verified: 0, other: 0 };
    });
    const idx = new Map(months.map((m, i) => [m.key, i]));
    for (const d of docs) {
      const k = (d.issued_at || d.created_at || '').slice(0, 7);
      const i = idx.get(k);
      if (i === undefined) continue;
      if (d.status === 'verified') months[i].verified++; else months[i].other++;
    }
    return months;
  }, [docs]);

  const max = Math.max(4, ...data.map((m) => m.verified + m.other));
  const W = 640, H = 220, padL = 28, padB = 34, padT = 14, bw = (W - padL) / 12;
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const total = data.reduce((n, m) => n + m.verified + m.other, 0);
  const ticks = [0, Math.round(max / 2), max];

  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Grafik jumlah surat per bulan, total ${total} surat dalam 12 bulan terakhir`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">{t}</text>
          </g>
        ))}
        {data.map((m, i) => {
          const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
          const hv = (H - padB - padT) * (m.verified / max), ho = (H - padB - padT) * (m.other / max);
          return (
            <g key={m.key}>
              <title>{`${m.label} ${m.year}: ${m.verified} terverifikasi, ${m.other} lainnya`}</title>
              {m.verified > 0 && <rect x={x} y={H - padB - hv} width={w} height={hv} rx={3} className="bar-ok" />}
              {m.other > 0 && <rect x={x} y={H - padB - hv - ho} width={w} height={ho} rx={3} className="bar-other" />}
              <text x={x + w / 2} y={H - padB + 15} textAnchor="middle" className="chart-tick">{m.label}</text>
              {(i === 0 || m.label === 'Jan') && <text x={x + w / 2} y={H - padB + 28} textAnchor="middle" className="chart-tick sub">{m.year}</text>}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend"><span><i className="bar-ok" />Terverifikasi</span><span><i className="bar-other" />Belum final / lainnya</span><span className="muted">{total} surat · 12 bulan terakhir</span></div>
    </div>
  );
}

/** Dokumen yang menunggu tanda tangan lebih lama dari batas pengingat, lengkap dengan tombol ingatkan lewat WhatsApp. */
export function OverduePanel({ docs, steps, owners, days, canRemind }: { docs: Doc[]; steps: DocSigner[]; owners: Signer[]; days: number; canRemind: boolean }) {
  const rows = useMemo(() => {
    const now = Date.now();
    return docs
      .filter((d) => d.status === 'pending' && d.created_at)
      .map((d) => ({ d, age: Math.floor((now - new Date(d.created_at!).getTime()) / dayMs), waiting: steps.filter((s) => s.document_id === d.id && s.status === 'pending') }))
      .filter((x) => x.age >= days)
      .sort((a, b) => b.age - a.age)
      .slice(0, 6);
  }, [docs, steps, days]);

  if (!rows.length) return null;
  return (
    <section className="panel overdue-panel">
      <div className="panel-head"><div><h3><Clock size={17} className="ico" />Menunggu tanda tangan terlalu lama</h3><p>Dokumen tertunda lebih dari {days} hari.</p></div><NavLink to="/dokumen" className="text-link">Kelola</NavLink></div>
      <ul className="attention-list">
        {rows.map(({ d, age, waiting }) => {
          const who = waiting[0];
          const owner = who ? owners.find((o) => o.id === who.owner_id) : undefined;
          return (
            <li key={d.id}>
              <div><b>{d.title}</b><small>{d.document_number} · menunggu {waiting.map((w) => w.signer_name).join(', ') || d.signer_name || 'penandatangan'} · <b>{age} hari</b></small></div>
              {canRemind && who && (
                <a className="button ghost sm" target="_blank" rel="noopener noreferrer" href={waLink(owner?.phone, signRequestText({ name: who.signer_name, number: d.document_number, title: d.title, url: signLink(d.id) }))}>
                  <MessageCircle size={13} />Ingatkan
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

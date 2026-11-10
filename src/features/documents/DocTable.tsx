import type { Doc, DocGroup } from '../../types';

export const statusLabel: Record<string, string> = { draft: 'Draf', pending: 'Menunggu TTE', verified: 'Terverifikasi', rejected: 'Ditolak', revoked: 'Dicabut', archived: 'Diarsipkan' };

export async function hashFile(file: File) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export type Selection = { ids: Set<string>; toggle: (id: string) => void; toggleAll: (ids: string[], on: boolean) => void };

type Props = {
  docs: Doc[];
  actions?: (d: Doc) => React.ReactNode;
  meId?: string;
  /** id dokumen yang menunggu tanda tangan akun ini */
  mineIds?: Set<string>;
  /** Bila diberikan, kolom "Kelompok" ditampilkan. renderGroup menggantikan chip bawaan (mis. dropdown). */
  groups?: DocGroup[];
  renderGroup?: (d: Doc) => React.ReactNode;
  selection?: Selection;
  /** menggantikan kolom Penandatangan (mis. daftar langkah) */
  renderSigner?: (d: Doc) => React.ReactNode;
  /** tambahan di sel status (mis. penanda tertunda lama) */
  statusExtra?: (d: Doc) => React.ReactNode;
};

export function GroupChip({ group }: { group?: DocGroup | null }) {
  if (!group) return <span className="muted">—</span>;
  return <span className="gchip" style={{ ['--gc' as any]: group.color }}><i />{group.name}</span>;
}

export default function DocTable({ docs, actions, meId, mineIds, groups, renderGroup, selection, renderSigner, statusExtra }: Props) {
  const byId = new Map((groups || []).map((g) => [g.id, g]));
  const showGroup = Boolean(groups);
  const cols = 5 + (actions ? 1 : 0) + (showGroup ? 1 : 0) + (selection ? 1 : 0);
  const allOn = Boolean(selection) && docs.length > 0 && docs.every((d) => selection!.ids.has(d.id));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {selection && <th className="cell-check"><input type="checkbox" aria-label="Pilih semua" checked={allOn} onChange={(e) => selection.toggleAll(docs.map((d) => d.id), e.target.checked)} /></th>}
            <th>Nomor dokumen</th><th>Perihal</th>{showGroup && <th>Kelompok</th>}<th>Penandatangan</th><th>Tanggal</th><th>Status</th>{actions && <th></th>}
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const mine = d.status === 'pending' && (mineIds ? mineIds.has(d.id) : Boolean(meId && d.signer_user_id === meId));
            return (
              <tr key={d.id} className={mine ? 'attention' : ''}>
                {selection && <td className="cell-check"><input type="checkbox" aria-label={`Pilih ${d.document_number}`} checked={selection.ids.has(d.id)} onChange={() => selection.toggle(d.id)} /></td>}
                <td><b>{d.document_number}</b>{d.short_code && <small className="mono code-sm">{d.short_code}</small>}</td>
                <td>{d.title}</td>
                {showGroup && <td>{renderGroup ? renderGroup(d) : <GroupChip group={d.group_id ? byId.get(d.group_id) : null} />}</td>}
                <td>{renderSigner ? renderSigner(d) : d.signer_name || '—'}</td>
                <td>{d.issued_at || '—'}</td>
                <td>
                  <span className={`status ${d.status === 'verified' ? 'good' : d.status === 'revoked' ? 'bad' : 'pending'}`}>{statusLabel[d.status] || d.status}</span>
                  {mine && <span className="status attn">Perlu TTE Anda</span>}
                  {statusExtra?.(d)}
                </td>
                {actions && <td>{actions(d)}</td>}
              </tr>
            );
          })}
          {!docs.length && <tr><td colSpan={cols} className="empty">Belum ada dokumen tersimpan.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

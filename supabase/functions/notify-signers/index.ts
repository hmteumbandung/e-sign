// SIGNATURE HUB HMTE: pengirim notifikasi permintaan tanda tangan (OPSIONAL, BELUM DIUJI di lingkungan Anda).
// Dipanggil oleh trigger database (supabase/workflow-setup.sql, fungsi notify_signer) lewat pg_net,
// atau berkala untuk pengingat (lihat README). Mengirim email lewat Resend dan/atau WhatsApp lewat Fonnte.
//
// Deploy:  supabase functions deploy notify-signers --no-verify-jwt
// Secrets: supabase secrets set NOTIFY_SECRET=... APP_URL=https://USER.github.io/signature-hub-hmte \
//            RESEND_API_KEY=... MAIL_FROM="SIGNATURE HUB <noreply@domain-anda>" FONNTE_TOKEN=...
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM =
  Deno.env.get("MAIL_FROM") ?? "SIGNATURE HUB <onboarding@resend.dev>";
const FONNTE_TOKEN = Deno.env.get("FONNTE_TOKEN") ?? "";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const normPhone = (p?: string | null) => {
  const d = (p ?? "").replace(/[^0-9]/g, "");
  if (!d) return "";
  return d.startsWith("62")
    ? d
    : d.startsWith("0")
      ? "62" + d.slice(1)
      : d.startsWith("8")
        ? "62" + d
        : d;
};

async function sendOne(opts: {
  userId?: string | null;
  ownerId?: string | null;
  name: string;
  number: string;
  title: string;
  docId: string;
  reminder?: boolean;
}) {
  const link = `${APP_URL}/#/penandatanganan?doc=${encodeURIComponent(opts.docId)}`;
  const text = `${opts.reminder ? "PENGINGAT: " : ""}Yth. ${opts.name},\n\nMohon tanda tangan elektronik untuk dokumen:\n${opts.number} - ${opts.title}\n\nBuka (login terlebih dahulu):\n${link}\n\nSIGNATURE HUB HMTE UMBandung`;
  const out: Record<string, string> = {};

  let email = "";
  if (opts.userId) {
    const u = await admin.auth.admin.getUserById(opts.userId);
    email = u.data.user?.email ?? "";
  }
  let phone = "";
  if (opts.ownerId) {
    const o = await admin
      .from("signature_owners")
      .select("phone")
      .eq("id", opts.ownerId)
      .maybeSingle();
    phone = normPhone((o.data as { phone?: string } | null)?.phone);
  }

  if (RESEND_KEY && email) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: `${opts.reminder ? "Pengingat: " : ""}Permintaan tanda tangan ${opts.number}`,
        text,
      }),
    });
    out.email = r.ok ? "terkirim" : `gagal ${r.status}`;
  }
  if (FONNTE_TOKEN && phone) {
    const r = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: {
        Authorization: FONNTE_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ target: phone, message: text }),
    });
    out.whatsapp = r.ok ? "terkirim" : `gagal ${r.status}`;
  }
  return out;
}

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-notify-secret") !== SECRET)
    return new Response("unauthorized", { status: 401 });
  if (req.method !== "POST")
    return new Response("method not allowed", { status: 405 });
  const body = (await req.json().catch(() => null)) as Record<
    string,
    any
  > | null;
  if (!body) return new Response("bad request", { status: 400 });

  if (body.type === "sign_request") {
    const res = await sendOne({
      userId: body.signer_user_id,
      ownerId: body.signer_owner_id,
      name: body.signer_name,
      number: body.document_number,
      title: body.title,
      docId: body.document_id,
    });
    return Response.json({ ok: true, ...res });
  }

  if (body.type === "reminder") {
    // pengingat berkala: langkah menunggu lebih dari N hari
    const days = Number(body.days) || 3;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await admin
      .from("documents")
      .select("id,document_number,title,created_at")
      .eq("status", "pending")
      .lte("created_at", since);
    let sent = 0;
    for (const d of data ?? []) {
      const { data: steps } = await admin
        .from("document_signers")
        .select("owner_id,user_id,signer_name")
        .eq("document_id", d.id)
        .eq("status", "pending");
      for (const s of steps ?? []) {
        await sendOne({
          userId: s.user_id,
          ownerId: s.owner_id,
          name: s.signer_name,
          number: d.document_number,
          title: d.title,
          docId: d.id,
          reminder: true,
        });
        sent++;
      }
    }
    return Response.json({ ok: true, sent });
  }
  return new Response("unknown type", { status: 400 });
});

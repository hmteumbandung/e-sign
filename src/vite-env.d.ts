/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Opsional: alamat publik situs yang dikodekan dalam QR, mis. https://hmte.example/signature-hub-hmte */
  readonly VITE_PUBLIC_URL?: string;
}

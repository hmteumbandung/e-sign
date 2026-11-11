export type Signer = {
  id: string;
  full_name: string;
  student_id: string | null;
  position: string;
  department: string | null;
  period: string | null;
  status: string;
  signature_path: string | null;
  user_id?: string | null;
  phone?: string | null;
};

export type Doc = {
  id: string;
  document_number: string;
  title: string;
  signer_name: string | null;
  issued_at: string | null;
  status: string;
  verification_id: string;
  sha256: string | null;
  file_path: string | null;
  original_file_path?: string | null;
  signer_user_id?: string | null;
  group_id?: string | null;
  letter_type?: string | null;
  short_code?: string | null;
  created_at?: string;
  signed_at?: string | null;
  sign_mode?: 'sequential' | 'parallel';
  reject_reason?: string | null;
  rejected_at?: string | null;
  revision?: number;
  public_access?: boolean;
};

export type StepStatus = 'waiting' | 'pending' | 'signed' | 'rejected';
export type DocSigner = {
  id: string;
  document_id: string;
  step: number;
  owner_id: string | null;
  user_id: string | null;
  signer_name: string;
  signer_position: string | null;
  status: StepStatus;
  signed_at: string | null;
  note: string | null;
};

export type Role = 'super_admin' | 'admin' | 'secretary' | 'signer' | 'viewer';

export type Profile = {
  id: string;
  full_name: string;
  nim?: string | null;
  email: string | null;
  role: Role;
  status: 'pending' | 'active' | 'suspended';
  created_at: string;
};

export type DocGroup = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  code?: string | null;
  number_format?: string | null;
  reset_period?: 'month' | 'year' | 'never' | null;
  created_at?: string;
};

export type AppSettings = {
  footer_text: string;
  number_format: string;
  number_reset: 'month' | 'year' | 'never';
  number_pad: string;
  reminder_days: number;
};
export const DEFAULT_SETTINGS: AppSettings = { footer_text: '', number_format: '{no}/HMTE/{bulan_romawi}/{tahun}', number_reset: 'month', number_pad: '3', reminder_days: 3 };

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  secretary: 'Sekretaris',
  signer: 'Penandatangan',
  viewer: 'Viewer',
};

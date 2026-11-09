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
  short_code?: string | null;
  created_at?: string;
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
  created_at?: string;
};

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  secretary: 'Sekretaris',
  signer: 'Penandatangan',
  viewer: 'Viewer',
};

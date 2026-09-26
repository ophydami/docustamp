/**
 * Types for the settings feature. Field names mirror the Parse classes exactly
 * (docs/BACKEND_API.md §3.3 contracts_Users, §3.4 partners_Tenant,
 * §3.8 contracts_Signature) so payloads can be built without translation.
 */

export type SectionId =
  | "profile"
  | "signature"
  | "notifications"
  | "security"
  | "general"
  | "team"
  | "branding"
  | "signing"
  | "email"
  | "integrations"
  | "api"
  | "audit"
  | "billing";

/** `SignatureType` entries on contracts_Users / partners_Tenant. */
export interface SignatureTypeEntry {
  name: string; // "draw" | "typed" | "upload" | "default"
  enabled: boolean;
}

/** `WidgetPreferences` date entry (the only type this build stores). */
export interface DateWidgetPreference {
  type: "date";
  isSigningDate?: boolean;
  isReadOnly?: boolean;
  date?: string;
  format?: string;
}

/** partners_Tenant as returned by the `gettenant` cloud function. */
export interface Tenant {
  objectId: string;
  TenantName?: string;
  EmailAddress?: string;
  ContactNumber?: string;
  Domain?: string;
  Logo?: string;
  Favicon?: string;
  /** Branding written by `updatetenant` (§4.1). */
  EmailSenderName?: string;
  EmailFooter?: string;
  HidePoweredBy?: boolean;
  ReplyTo?: string;
  IsActive?: boolean;
  Address?: string;
  City?: string;
  State?: string;
  Country?: string;
  PinCode?: string;
  SignatureType?: SignatureTypeEntry[];
  RequestBody?: string;
  RequestSubject?: string;
  CompletionBody?: string;
  CompletionSubject?: string;
  EmailEditorType?: EmailEditorType;
  createdAt?: string;
  updatedAt?: string;
}

/** contracts_Signature (§3.8). `ImageURL` may be a presigned URL or a data URL. */
export interface SignatureRecord {
  objectId: string;
  ImageURL?: string;
  Initials?: string;
  Stamp?: string;
  SignatureName?: string;
  updatedAt?: string;
}

/** A row of `getuserlistbyorg` (a contracts_Users object). */
export interface TeamMember {
  objectId: string;
  Name?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  JobTitle?: string;
  UserRole?: string;
  IsDisabled?: boolean;
  Timezone?: string;
  createdAt?: string;
  updatedAt?: string;
  UserId?: { objectId: string; email?: string; username?: string };
  TeamIds?: Array<{ objectId: string; Name?: string }>;
}

export interface TeamRecord {
  objectId: string;
  Name?: string;
  IsActive?: boolean;
}

/** `EmailEditorType` is an object, one entry per template. */
export interface EmailEditorType {
  request?: "basic" | "advanced";
  completion?: "basic" | "advanced";
}

/** Mail templates live on both the tenant and the user row (§2.8). */
export interface MailTemplates {
  RequestSubject: string;
  RequestBody: string;
  CompletionSubject: string;
  CompletionBody: string;
  EmailEditorType: EmailEditorType;
}

export interface DocumentExportRow {
  objectId: string;
  Name?: string;
  Note?: string;
  IsCompleted?: boolean;
  IsDeclined?: boolean;
  DeclineReason?: string;
  SignedUrl?: string;
  ExpiryDate?: { iso?: string } | string;
  DocSentAt?: { iso?: string } | string;
  createdAt?: string;
  updatedAt?: string;
  ExtUserPtr?: { Name?: string; Email?: string };
  Signers?: Array<{ Name?: string; Email?: string }>;
}

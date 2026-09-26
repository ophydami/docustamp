/**
 * Plain records the inbox renders. Parse JSON is converted to these in api.ts;
 * nothing below this line knows about Parse.
 */

export type DocStatus = "draft" | "needsYou" | "waiting" | "completed" | "declined" | "expired";

export type InboxTab = "all" | "needsYou" | "inProgress" | "completed" | "declined" | "drafts";

export interface Recipient {
  /** 1-based position in the signing order. */
  order: number;
  /** contracts_Contactbook objectId, absent until a guest binds themselves to the doc. */
  contactId?: string;
  /** The shadow _User behind the contact. */
  userId?: string;
  name: string;
  email: string;
  role?: string;
  isMe: boolean;
  /** ISO date of this person's "Signed" audit entry. */
  signedAt?: string;
  /** ISO date of their last "Viewed" audit entry (the server keeps only the latest). */
  viewedAt?: string;
  /** How many times they opened their signing link; every open counts. */
  openCount?: number;
  lastOpenedAt?: string;
}

export interface ActivityEntry {
  at?: string;
  who: string;
  what: string;
}

export interface DocumentRecord {
  id: string;
  name: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  expiryDate?: string;
  /** When `sendreminder` last chased this document, if it ever has. */
  lastReminderAt?: string;
  /** Last "Signed" audit entry on a completed document. */
  completedAt?: string;
  status: DocStatus;
  isDraft: boolean;
  isCompleted: boolean;
  isDeclined: boolean;
  isExpired: boolean;
  isSelfSign: boolean;
  /** The signed-in user owns this document. */
  isMine: boolean;
  /** It is this user's turn to sign. */
  needsMe: boolean;
  sendInOrder: boolean;
  declineReason?: string;
  recipients: Recipient[];
  signedCount: number;
  /** Highest page number any field sits on. Absent when there are no fields. */
  pageCount?: number;
  /** My contracts_Contactbook id on this document, for the signing link. */
  myContactId?: string;
  /** Who the document is waiting on, when that is a single person. */
  nextSigner?: Recipient;
  activity: ActivityEntry[];
  owner: { extUserId?: string; name?: string; email?: string };
  /** Original PDF. Only signed (fetchable) on the single-document read. */
  url?: string;
  /** Working PDF: set at send time, replaced after every signature. */
  signedUrl?: string;
}

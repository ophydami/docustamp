/**
 * One rule for reading the recipients off a contracts_Document.
 *
 * A document carries two arrays: `Placeholders` (the seats, with the role, the
 * fields and the colour) and `Signers` (the contracts_Contactbook rows). They
 * are only index-parallel by convention. `linkcontacttodoc` splices a signer in
 * at the placeholder's index and `signerObjId` / `signerPtr` are written when a
 * seat is bound, so the index alone is the weakest of the three links: a seat
 * bound after the fact can misalign it.
 *
 * The resolution order is therefore:
 *   1. the Signers row whose objectId equals the placeholder's `signerObjId`
 *   2. the placeholder's own resolved `signerPtr` (when it has an objectId)
 *   3. `Signers[index]`, the legacy pairing
 *
 * The inbox and the documents list used to disagree here (the inbox paired by
 * index and only preferred a bound `signerPtr`), so the same document could
 * name different people on two screens, with reminders and declines then taken
 * against the person on screen. Both features call this now.
 *
 * What stays per feature, deliberately:
 *  - the inbox falls back to the raw `Signers` list when a document has no
 *    placeholders at all (legacy rows), the documents page does not: it shows
 *    the owner instead for a self-signed document.
 *  - the inbox drops a seat with neither a contact nor an address always; the
 *    documents page keeps them for a self-sign document, where the seat is the
 *    owner's own field holder.
 *  - the shapes: the inbox numbers recipients from 1, the documents page from 0
 *    and adds colours, state and field counts.
 */

/** The bits of a contracts_Contactbook row this pairing needs. */
export interface SeatContact {
  objectId?: string;
  Name?: string;
  Email?: string;
  UserId?: { objectId?: string };
}

/** The bits of one `Placeholders[]` entry this pairing needs. */
export interface SeatPlaceholder<C extends SeatContact = SeatContact> {
  Role?: string;
  email?: string;
  signerObjId?: string;
  signerPtr?: C;
}

export interface Seat<P, C> {
  /** Position among the non-prefill placeholders: the signing order. */
  index: number;
  /** The placeholder this seat came from, or undefined on the Signers fallback. */
  placeholder?: P;
  contact?: C;
  /** The contact's address, or the placeholder's own `email` for an unbound seat. */
  email: string;
  role?: string;
}

/** `prefill` is a magic role for owner-filled fields, not a person (§6.2). */
export function isPrefill(placeholder: { Role?: string } | undefined): boolean {
  return placeholder?.Role === "prefill";
}

/** Drop the prefill seats, keeping the order the document stores. */
export function signerPlaceholders<P extends { Role?: string }>(placeholders: P[] | undefined): P[] {
  return (Array.isArray(placeholders) ? placeholders : []).filter((p) => !!p && !isPrefill(p));
}

/**
 * Pair each non-prefill placeholder with its contact.
 *
 * @param opts.fallbackToSigners answer with one seat per `Signers` row when the
 *   document has no placeholders at all (the inbox does this, see above).
 */
export function toSeats<C extends SeatContact, P extends SeatPlaceholder<C>>(
  placeholders: P[] | undefined,
  signers: C[] | undefined,
  opts: { fallbackToSigners?: boolean } = {}
): Array<Seat<P, C>> {
  const list = signerPlaceholders(placeholders);
  const rows = Array.isArray(signers) ? signers : [];

  if (!list.length && opts.fallbackToSigners) {
    return rows.map((contact, index) => ({
      index,
      contact,
      email: contact?.Email ?? ""
    }));
  }

  return list.map((placeholder, index) => {
    const contact = contactForSeat(placeholder, rows, index);
    return {
      index,
      placeholder,
      contact,
      email: contact?.Email ?? placeholder.email ?? "",
      role: placeholder.Role
    };
  });
}

/** The three-step resolution above, for a caller that already has the index. */
export function contactForSeat<C extends SeatContact, P extends SeatPlaceholder<C>>(
  placeholder: P,
  signers: C[],
  index: number
): C | undefined {
  const bound = placeholder.signerObjId
    ? signers.find((s) => s?.objectId && s.objectId === placeholder.signerObjId)
    : undefined;
  if (bound) return bound;
  if (placeholder.signerPtr?.objectId) return placeholder.signerPtr;
  return signers[index];
}

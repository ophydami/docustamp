/**
 * "This row is a document, not a folder."
 *
 * Every bucket has to spell this the same way. The declined report used to say
 * `Type: null` while the others said `{$ne: 'Folder'}`: equivalent only for as
 * long as `Type` is either "Folder" or absent, and silently different for any
 * row a later schema gives a third value.
 */
const NOT_A_FOLDER = { $ne: 'Folder' };

/**
 * The access clause for the templates report.
 *
 * It used to live in an `if (reportId == '6TeaPr321t')` branch inside getReport,
 * which meant the descriptor itself matched every template on the server across
 * every tenant and was only safe because one caller remembered to bolt the owner
 * clause on afterwards. It is built here now, so no descriptor is executable
 * without an owner constraint.
 *
 * @param {string} currentUserId `_User` objectId of the caller.
 * @param {{extUserId?: string, teamAncestors?: string[]}} [access]
 */
function templateAccessWhere(currentUserId, access = {}) {
  const userPtr = { __type: 'Pointer', className: '_User', objectId: currentUserId };
  const extUserId = access.extUserId || '';
  const teams = Array.isArray(access.teamAncestors) ? access.teamAncestors : [];
  if (!extUserId || teams.length === 0) {
    return { CreatedBy: userPtr };
  }
  const extPtr = { __type: 'Pointer', className: 'contracts_Users', objectId: extUserId };
  return {
    $or: [{ SharedWith: { $in: teams } }, { ExtUserPtr: extPtr }, { SharedWithUsers: extPtr }],
  };
}

/**
 * The descriptor (where clause plus projected keys) for one report id.
 *
 * @param {string} id report id.
 * @param {string} currentUserId `_User` objectId of the caller.
 * @param {{extUserId?: string, teamAncestors?: string[]}} [access] the caller's
 *   ext-user row and team ancestors, used by the reports whose access rule is
 *   wider than "CreatedBy is me".
 */
export default function reportJson(id, currentUserId, access = {}) {
  const commanKeys = [
    'IsSignyourself',
    'URL',
    'Name',
    'Note',
    'SignedUrl',
    'AuditTrail',
    'OpenStats',
    'Folder.Name',
    'ExtUserPtr.Name',
    'ExtUserPtr.Email',
    'ExtUserPtr.DownloadFilenameFormat',
    'ExtUserPtr.Company',
    'ExtUserPtr.Phone',
    'Signers.Name',
    'Signers.Email',
    'Signers.Phone',
    'Placeholders',
    'TemplateId',
    'ExpiryDate',
    'SenderName',
    'SenderMail',
    // Status fields. Without these every report answered with IsCompleted and
    // IsDeclined missing, so the inbox computed "waiting" for documents that
    // were long since signed or declined, and never had a reason to show.
    'IsCompleted',
    'IsDeclined',
    'DeclineReason',
    'SendinOrder',
    'DocSentAt',
    'LastReminderAt',
  ];
  const inProgressKeys = [
    ...commanKeys,
    'AuditTrail.UserPtr',
    'SendMail',
    'RequestBody',
    'RequestSubject',
    'EmailEditorType',
    'ExtUserPtr.TenantId.RequestBody',
    'ExtUserPtr.TenantId.RequestSubject',
    'ExtUserPtr.TenantId.EmailEditorType',
  ];
  const filterKeys = [
    'TimeToCompleteDays',
    'AllowModifications',
    'IsEnableOTP',
    'IsTourEnabled',
    'NotifyOnSignatures',
    'RedirectUrl',
  ];
  const needYourSignKeys = [...commanKeys, 'Signers.UserId'];
  switch (id) {
    // draft documents report
    case 'ByHuevtCFY':
      return {
        reportName: 'Draft Documents',
        params: {
          Type: { $ne: 'Folder' },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          SignedUrl: { $exists: false },
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
        },
        keys: [...commanKeys, ...filterKeys],
      };
    // Need your sign report
    case '4Hhwbp482K':
      return {
        reportName: 'Need your sign',
        params: {
          Type: { $ne: 'Folder' },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          SignedUrl: { $ne: null },
          ExpiryDate: { $gt: { __type: 'Date', iso: new Date().toISOString() } },
          Placeholders: { $ne: null },
          Signers: {
            $inQuery: {
              where: { UserId: { __type: 'Pointer', className: '_User', objectId: currentUserId } },
              className: 'contracts_Contactbook',
            },
          },
        },
        keys: [...needYourSignKeys, ...filterKeys],
      };
    // In progress report
    case '1MwEuxLEkF':
      return {
        reportName: 'In-progress documents',
        params: {
          Type: { $ne: 'Folder' },
          SignedUrl: { $ne: null },
          Placeholders: { $ne: null },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
          ExpiryDate: { $gt: { __type: 'Date', iso: new Date().toISOString() } },
        },
        keys: [...inProgressKeys, ...filterKeys],
      };
    // completed documents report
    case 'kQUoW4hUXz':
      return {
        reportName: 'Completed Documents',
        params: {
          Type: { $ne: 'Folder' },
          IsCompleted: true,
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          $or: [
            // Condition 1: If `CreatedBy` exists, no need for `Signers` filter
            { CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId } },
            // Condition 2: If `CreatedBy` does not exist, apply the `Signers` filter
            {
              Signers: {
                $inQuery: {
                  where: {
                    UserId: { __type: 'Pointer', className: '_User', objectId: currentUserId },
                  },
                  className: 'contracts_Contactbook',
                },
              },
            },
          ],
        },
        keys: [...commanKeys, ...filterKeys],
      };
    //  declined documents report
    case 'UPr2Fm5WY3':
      return {
        reportName: 'Declined Documents',
        params: {
          Type: NOT_A_FOLDER,
          IsArchive: { $ne: true },
          IsDeclined: true,
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
        },
        keys: [...commanKeys],
      };
    //  Expired Documents report
    case 'zNqBHXHsYH':
      return {
        reportName: 'Expired Documents',
        params: {
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          Type: { $ne: 'Folder' },
          SignedUrl: { $ne: null },
          ExpiryDate: { $lt: { __type: 'Date', iso: new Date().toISOString() } },
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
        },
        keys: [...commanKeys, ...filterKeys],
      };
    //  Recently sent for signatures report show on dashboard
    case 'd9k3UfYHBc':
      return {
        reportName: 'Recently sent for signatures',
        params: {
          Type: { $ne: 'Folder' },
          SignedUrl: { $ne: null },
          Placeholders: { $ne: null },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
          ExpiryDate: { $gt: { __type: 'Date', iso: new Date().toISOString() } },
        },
        keys: inProgressKeys,
      };
    //  Recent signature requests report show on dashboard
    case '5Go51Q7T8r':
      return {
        reportName: 'Recent signature requests',
        params: {
          Type: { $ne: 'Folder' },
          SignedUrl: { $ne: null },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          ExpiryDate: { $gt: { __type: 'Date', iso: new Date().toISOString() } },
          Placeholders: { $ne: null },
          Signers: {
            $inQuery: {
              where: { UserId: { __type: 'Pointer', className: '_User', objectId: currentUserId } },
              className: 'contracts_Contactbook',
            },
          },
        },
        keys: needYourSignKeys,
      };
    // Drafts report show on dashboard
    case 'kC5mfynCi4':
      return {
        reportName: 'Drafts',
        params: {
          Type: { $ne: 'Folder' },
          IsCompleted: { $ne: true },
          IsDeclined: { $ne: true },
          IsArchive: { $ne: true },
          SignedUrl: { $exists: false },
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
        },
        keys: commanKeys,
      };
    // contact book report
    case 'contacts':
      return {
        reportName: 'Contactbook',
        reportClass: 'contracts_Contactbook',
        params: {
          CreatedBy: { __type: 'Pointer', className: '_User', objectId: currentUserId },
          IsDeleted: { $ne: true },
        },
        keys: ['Name', 'Email', 'Phone', 'JobTitle', 'Company'],
      };
    // Templates report
    case '6TeaPr321t':
      return {
        reportName: 'Templates',
        reportClass: 'contracts_Template',
        params: {
          Type: NOT_A_FOLDER,
          IsArchive: { $ne: true },
          ...templateAccessWhere(currentUserId, access),
        },
        keys: [
          ...commanKeys,
          ...filterKeys,
          'IsPublic',
          'SharedWith.Name',
          'SendinOrder',
          'SignatureType',
          'NotifyOnSignatures',
        ],
      };
    default:
      return null;
  }
}

// Escape regex special characters. Copied from filterDocs.js
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies searchTerm rules; combines existing access $or with search $or using $and.
 */
export function applySearch({ reportId, baseWhere, searchTerm }) {
  if (!searchTerm) return baseWhere;

  const escaped = escapeRegExp(searchTerm);
  const nameMatch = { Name: { $regex: `.*${escaped}.*`, $options: 'i' } };
  const emailMatch = { Email: { $regex: `.*${escaped}.*`, $options: 'i' } };

  if (reportId === 'contacts') {
    return { ...baseWhere, $or: [nameMatch, emailMatch] };
  }

  const searchOr = [
    nameMatch,
    { Signers: { $inQuery: { className: 'contracts_Contactbook', where: emailMatch } } },
  ];

  // If baseWhere already has an access-control $or, combine using $and
  if (baseWhere.$or) {
    const { $or: accessOr, ...rest } = baseWhere;
    return { ...rest, $and: [{ $or: accessOr }, { $or: searchOr }] };
  }

  return { ...baseWhere, $or: searchOr };
}

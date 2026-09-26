import { extUserPointer, userPointer } from './context.js';

/**
 * Folders are `contracts_Document` rows with `Type: "Folder"` (the web app's
 * drive). `create_document` and `update_draft` accept a `folderId`; these two
 * let an agent discover and create one.
 */

const MAX_FOLDER_NAME = 250;

function folderJson(row) {
  const j = row?.toJSON ? row.toJSON() : row;
  return {
    objectId: j.objectId,
    name: j.Name || '',
    parentId: j.Folder?.objectId || undefined,
    createdAt: j.createdAt,
  };
}

function baseQuery(caller) {
  const q = new Parse.Query('contracts_Document');
  q.equalTo('Type', 'Folder');
  q.equalTo('CreatedBy', userPointer(caller));
  q.notEqualTo('IsArchive', true);
  return q;
}

export async function listFolders(caller, { parentId, limit = 200 } = {}) {
  const q = baseQuery(caller);
  if (parentId) {
    q.equalTo('Folder', { __type: 'Pointer', className: 'contracts_Document', objectId: String(parentId) });
  }
  q.ascending('Name');
  q.limit(Math.min(500, Math.max(1, Number(limit) || 200)));
  q.select('Name', 'Folder');
  const rows = await q.find({ useMasterKey: true });
  const folders = rows.map(folderJson);
  // Document counts per folder, in one query over the caller's own documents.
  const docs = new Parse.Query('contracts_Document');
  docs.notEqualTo('Type', 'Folder');
  docs.notEqualTo('IsArchive', true);
  docs.equalTo('CreatedBy', userPointer(caller));
  docs.exists('Folder');
  docs.select('Folder');
  docs.limit(2000);
  const tally = new Map();
  for (const d of await docs.find({ useMasterKey: true })) {
    const id = d.get('Folder')?.id;
    if (id) tally.set(id, (tally.get(id) || 0) + 1);
  }
  return folders.map(f => ({ ...f, documents: tally.get(f.objectId) || 0 }));
}

export async function createFolder(caller, { name, parentId } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Give the folder a name.');
  if (trimmed.length > MAX_FOLDER_NAME) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, `Folder names are at most ${MAX_FOLDER_NAME} characters.`);
  }
  let parent = null;
  if (parentId) {
    const p = await baseQuery(caller).get(String(parentId), { useMasterKey: true }).catch(() => null);
    if (!p) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, `Folder ${parentId} not found.`);
    parent = { __type: 'Pointer', className: 'contracts_Document', objectId: p.id };
  }
  const dupe = baseQuery(caller);
  dupe.equalTo('Name', trimmed);
  if (parent) dupe.equalTo('Folder', parent);
  else dupe.doesNotExist('Folder');
  const existing = await dupe.first({ useMasterKey: true });
  if (existing) return { ...folderJson(existing), created: false };

  const row = new Parse.Object('contracts_Document');
  row.set('Name', trimmed);
  row.set('Type', 'Folder');
  row.set('CreatedBy', userPointer(caller));
  row.set('ExtUserPtr', extUserPointer(caller));
  if (parent) row.set('Folder', parent);
  const saved = await row.save(null, { useMasterKey: true });
  return { ...folderJson(saved), created: true };
}

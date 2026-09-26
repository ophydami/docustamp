/**
 * The caller's saved signature row.
 *
 * `savesignature` used to insert a fresh row on every adopt (the signer flow
 * sends no `id`), so a user could end up with several. `first()` with no sort
 * returned whichever the storage engine happened to hand back first, which is
 * how the settings page could render an image the user had already replaced.
 * Newest wins here, and `savesignature` upserts so new duplicates stop
 * appearing at all.
 */
export default async function getSignature(request) {
  const { userId } = request.params;
  if (!userId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing userId parameter.');
  }
  if (userId !== request.user?.id) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Cannot read the signature of another user.');
  }
  try {
    const query = new Parse.Query('contracts_Signature');
    query.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: userId });
    query.descending('updatedAt');
    const result = await query.first({ useMasterKey: true });
    return result;
  } catch (err) {
    console.error('Error fetching signature:', err);
    throw err;
  }
}

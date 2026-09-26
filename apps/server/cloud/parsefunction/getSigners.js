// Function to escape special characters in the search string
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape special characters
}

/**
 * The caller's own contacts matching `search`.
 *
 * This used to take an `isJWT` flag choosing between the master key and the
 * caller's session token, but the single call site never passed it, so the
 * master-key branch was unreachable and read as though an API-token path
 * existed. It does not: `getsigners` needs a session, and `searchObj.sessionToken`
 * would be empty for a token caller.
 */
async function getContacts(searchObj) {
  try {
    const escapedSearch = escapeRegExp(searchObj.search); // Escape the search input
    const searchRegex = new RegExp(escapedSearch, 'i'); // Create regex once to reuse
    const contactNameQuery = new Parse.Query('contracts_Contactbook');
    contactNameQuery.matches('Name', searchRegex);

    const conatctEmailQuery = new Parse.Query('contracts_Contactbook');
    conatctEmailQuery.matches('Email', searchRegex);

    // Combine the two queries with OR
    const mainQuery = Parse.Query.or(contactNameQuery, conatctEmailQuery);

    // Add the common condition for 'CreatedBy'
    mainQuery.equalTo('CreatedBy', searchObj.CreatedBy);
    mainQuery.notEqualTo('IsDeleted', true);
    const contactRes = await mainQuery.find({ sessionToken: searchObj.sessionToken });
    const _contactRes = JSON.parse(JSON.stringify(contactRes));
    return _contactRes;
  } catch (err) {
    console.log('err while fetch contacts', err);
    throw err;
  }
}
export default async function getSigners(request) {
  const searchObj = { search: request.params.search || '', sessionToken: '' };
  try {
    if (request.user) {
      searchObj.CreatedBy = { __type: 'Pointer', className: '_User', objectId: request?.user?.id };
      searchObj.sessionToken = request.user.getSessionToken();
      return await getContacts(searchObj);
    } else {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
    }
  } catch (err) {
    console.log('err in get signers', err);
    throw err;
  }
}

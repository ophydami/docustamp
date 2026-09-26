/**
 * Quota counters on `contracts_Users`.
 *
 * Both helpers use `increment()`, which parse-server turns into a single atomic
 * `$inc`. `setDocumentCount` used to read `DocumentCount`, add in JavaScript and
 * save the whole value, so two documents created at the same moment each read
 * the same starting value and one write won: the count drifted low, invisibly,
 * because every failure was swallowed into a `console.log`.
 *
 * Failures are logged at error level and the promise still resolves: a counter
 * is not worth failing a document creation over, but it must be visible when it
 * breaks.
 */
export const setDocumentCount = async (extUserId, docsCount) => {
  if (!extUserId) return;
  try {
    // Update count in contracts_Users class
    const extQuery = new Parse.Query('contracts_Users');
    extQuery.equalTo('objectId', extUserId);
    const contractUser = await extQuery.first({ useMasterKey: true });
    if (contractUser) {
      const step = Number(docsCount) || 1;
      contractUser.increment('DocumentCount', step);
      await contractUser.save(null, { useMasterKey: true });
    }
  } catch (error) {
    console.error('Error updating document count in contracts_Users: ' + error.message);
  }
};

export const setTemplateCount = async extUserId => {
  if (!extUserId) return;
  try {
    // Update count in contracts_Users class
    const extQuery = new Parse.Query('contracts_Users');
    extQuery.equalTo('objectId', extUserId);
    const contractUser = await extQuery.first({ useMasterKey: true });
    if (contractUser) {
      contractUser.increment('TemplateCount', 1);
      await contractUser.save(null, { useMasterKey: true });
    }
  } catch (error) {
    console.error('Error updating template count in contracts_Users: ' + error.message);
  }
};

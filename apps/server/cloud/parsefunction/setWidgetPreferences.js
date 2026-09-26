import { extUserForUser } from './authGuard.js';

export default async function setWidgetPreferences(request) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const dateWidgetParams = request?.params?.dateWidget;
  if (!dateWidgetParams || Object.keys(dateWidgetParams).length === 0) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Please provide parameters.');
  }
  try {
    const userObj = await extUserForUser(request.user);
    if (!userObj) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Permission denied.');
    }

    const widgetPreferencesRaw = userObj?.get('WidgetPreferences');
    const widgetPreferences = Array.isArray(widgetPreferencesRaw) ? widgetPreferencesRaw : [];

    // Normalize booleans (simple + safe)
    const dateWidget = {
      type: 'date',
      isSigningDate: !!dateWidgetParams.isSigningDate,
      isReadOnly: !!dateWidgetParams.isReadOnly,
      date: dateWidgetParams?.isSigningDate ? '' : dateWidgetParams?.date || '',
      format: dateWidgetParams.format || 'MM/dd/yyyy',
    };

    // Upsert: replace the `date` entry if there is one, otherwise append.
    // This used to branch on whether the array was non-empty at all, so a user
    // who already had any other preference (a signature entry, say) had their
    // new date preference quietly dropped while the call still answered 200.
    const dateAt = widgetPreferences.findIndex(w => w?.type === 'date');
    const updatedWidgetPreferences =
      dateAt === -1
        ? [...widgetPreferences, dateWidget]
        : widgetPreferences.map((w, index) => (index === dateAt ? dateWidget : w));

    userObj.set('WidgetPreferences', updatedWidgetPreferences);
    const saved = await userObj.save(null, { useMasterKey: true });
    if (saved) {
      const response = typeof saved.toJSON === 'function' ? saved.toJSON() : saved;
      return {
        WidgetPreferences: response.WidgetPreferences,
        updatedAt: response.updatedAt,
        createdAt: response.createdAt,
      };
    }
  } catch (err) {
    console.log('set widget preferences error:', err);
    throw new Parse.Error(err?.code || 400, err?.message || 'Something went wrong.');
  }
}

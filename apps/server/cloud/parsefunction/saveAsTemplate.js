import { randomId } from '../../Utils.js';
import { readFresh } from '../lib/atomic.js';
import { resetPlaceholdersForCopy, resetWidgetForCopy } from '../lib/widgets.js';

/** Copied only when the source really has a value, so a template is never stamped with `undefined`. */
function copyIfPresent(target, field, value) {
  if (value !== undefined && value !== null) target.set(field, value);
}

export default async function saveAsTemplate(request) {
  const docId = request.params.docId;
  const Ip = request?.headers?.['x-real-ip'] || '';

  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'user is not authenticated.');
  }
  try {
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.equalTo('objectId', docId);
    docQuery.equalTo('CreatedBy', request.user);
    docQuery.include('ExtUserPtr');
    docQuery.include('ExtUserPtr.TenantId');
    docQuery.notEqualTo('IsArchive', true);
    const docRes = await docQuery.first({ useMasterKey: true });
    if (docRes) {
      // The stored row, read again with no triggers: `docRes` came out of a query
      // and the afterFind trigger replaced URL / SignedUrl / CertificateUrl with
      // presigned links that expire in a couple of minutes, so `_docRes.URL`
      // would make an expiring, credential-bearing url the template's canonical
      // file for every document ever created from it.
      const _docRes = (await readFresh('contracts_Document', docRes.id)) || docRes.toJSON();
      const templateCls = new Parse.Object('contracts_Template');
      copyIfPresent(templateCls, 'URL', _docRes?.URL);
      copyIfPresent(templateCls, 'Name', _docRes?.Name);
      copyIfPresent(templateCls, 'Note', _docRes?.Note);
      copyIfPresent(templateCls, 'Description', _docRes?.Description);
      templateCls.set('OriginIp', Ip);
      templateCls.set('SendinOrder', _docRes?.SendinOrder || false);
      templateCls.set('SendInOrderStrict', _docRes?.SendInOrderStrict || false);
      templateCls.set('AutomaticReminders', _docRes?.AutomaticReminders || false);
      copyIfPresent(templateCls, 'ExtUserPtr', _docRes?.ExtUserPtr);
      copyIfPresent(templateCls, 'CreatedBy', _docRes?.CreatedBy);
      templateCls.set('IsEnableOTP', _docRes?.IsEnableOTP === true ? true : false);
      templateCls.set('IsTourEnabled', _docRes?.IsTourEnabled === true ? true : false);
      templateCls.set('AllowModifications', _docRes?.AllowModifications || false);
      copyIfPresent(templateCls, 'SenderName', _docRes?.SenderName);
      copyIfPresent(templateCls, 'SenderMail', _docRes?.SenderMail);
      copyIfPresent(templateCls, 'RequestBody', _docRes?.RequestBody);
      copyIfPresent(templateCls, 'RequestSubject', _docRes?.RequestSubject);
      if (_docRes?.EmailEditorType) templateCls.set('EmailEditorType', _docRes?.EmailEditorType);
      // NextReminderDate is deliberately not copied. It is per-send scheduling
      // state belonging to the source document's run, usually already in the
      // past, and TemplateAfterSave computes the template's own from its
      // createdAt when AutomaticReminders is on. Copying it left a template
      // carrying a stale date the reminder job could treat as immediately due.
      copyIfPresent(templateCls, 'RedirectUrl', _docRes?.RedirectUrl);
      templateCls.set(
        'NotifyOnSignatures',
        _docRes?.NotifyOnSignatures !== undefined ? _docRes?.NotifyOnSignatures : false
      );
      templateCls.set(
        'TimeToCompleteDays',
        _docRes?.TimeToCompleteDays ? parseInt(_docRes?.TimeToCompleteDays) : 15
      );
      if (_docRes?.RemindOnceInEvery) {
        templateCls.set('RemindOnceInEvery', parseInt(_docRes?.RemindOnceInEvery));
      }

      if (_docRes?.Placeholders?.length > 0) {
        // One reset helper for every copy path in the product
        // (`cloud/lib/widgets.js`): no captured response, no carried default, no
        // signature image, no read-only lock, and the legacy `text` type mapped
        // to `text input` as this path has always done.
        const reset = {
          clearDefaults: true,
          clearReadOnly: true,
          legacyTextType: true,
        };
        if (_docRes?.IsSignyourself) {
          // A self-signed draft stores a flat `[{pageNumber, pos}]` array with no
          // signer wrapper, and every field of it becomes required on the one
          // role the template gets.
          const updatedPlaceholder = _docRes.Placeholders.map(pageItem => ({
            ...pageItem,
            pos: (pageItem.pos || []).map(p =>
              resetWidgetForCopy(p, { ...reset, requireAll: true })
            ),
          }));
          templateCls.set('Placeholders', [
            {
              signerObjId: '',
              signerPtr: {},
              Id: randomId(),
              blockColor: '#93a3db',
              Role: 'Role 1',
              email: '',
              placeHolder: updatedPlaceholder,
            },
          ]);
        } else {
          // The owner's prefill values belong to the document that was sent, not
          // to a reusable template, and every role is unbound so the template can
          // be reused with different people.
          templateCls.set(
            'Placeholders',
            resetPlaceholdersForCopy(_docRes.Placeholders, {
              ...reset,
              keepPrefill: false,
              unbind: true,
            })
          );
        }
      }
      if (_docRes?.SignatureType?.length > 0) {
        templateCls.set('SignatureType', _docRes?.SignatureType);
      }
      if (_docRes?.Bcc?.length > 0) {
        templateCls.set('Bcc', _docRes?.Bcc);
      }
      if (_docRes?.Cc?.length > 0) {
        templateCls.set('Cc', _docRes?.Cc);
      }
      if (_docRes?.PenColors?.length > 0) {
        templateCls.set('PenColors', _docRes?.PenColors);
      }
      const res = await templateCls.save(null, { useMasterKey: true });
      return res;
    } else {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'document not found.');
    }
  } catch (err) {
    console.log('Err in save as template', err);
    throw err;
  }
}

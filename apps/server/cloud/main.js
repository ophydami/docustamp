import PDF from './parsefunction/pdf/PDF.js';
import sendmailv3 from './parsefunction/sendMailv3.js';
import recordFileUsage from './parsefunction/recordFileUsage.js';
import usersignup from './parsefunction/usersignup.js';
import DocumentAftersave from './parsefunction/DocumentAftersave.js';
import ContactbookAftersave from './parsefunction/ContactBookAftersave.js';
import sendMailOTPv1 from './parsefunction/SendMailOTPv1.js';
import AuthLoginAsMail from './parsefunction/AuthLoginAsMail.js';
import getUserDetails from './parsefunction/getUserDetails.js';
import getDocument from './parsefunction/getDocument.js';
import getDocumentOpens from './parsefunction/getDocumentOpens.js';
import getReport from './parsefunction/getReport.js';
import TemplateAfterSave from './parsefunction/TemplateAfterSave.js';
import GetTemplate from './parsefunction/GetTemplate.js';
import DocumentBeforesave from './parsefunction/DocumentBeforesave.js';
import TemplateBeforeSave from './parsefunction/TemplateBeforesave.js';
import DocumentBeforeFind from './parsefunction/DocumentAfterFind.js';
import TemplateAfterFind from './parsefunction/TemplateAfterFind.js';
import UserAfterFind from './parsefunction/UserAfterFInd.js';
import SignatureAfterFind from './parsefunction/SignatureAfterFind.js';
import TenantAterFind from './parsefunction/TenantAfterFind.js';
import { getSignedUrl } from './parsefunction/getSignedUrl.js';
import createBatchDocs from './parsefunction/createBatchDocs.js';
import linkContactToDoc from './parsefunction/linkContactToDoc.js';
import TeamsAftersave from './parsefunction/TeamsAftersave.js';
import GetLogoByDomain from './parsefunction/GetLogoByDomain.js';
import AddAdmin from './parsefunction/AddAdmin.js';
import CheckAdminExist from './parsefunction/CheckAdminExist.js';
import getTeams from './parsefunction/getTeams.js';
import getContact from './parsefunction/getContact.js';
import declinedocument from './parsefunction/declinedocument.js';
import getTenant from './parsefunction/getTenant.js';
import getSigners from './parsefunction/getSigners.js';
import savecontact from './parsefunction/savecontact.js';
import updateSignatureType from './parsefunction/updatesignaturetype.js';
import updatePreferences from './parsefunction/updatePreferences.js';
import createDuplicate from './parsefunction/createDuplicate.js';
import generateCertificatebydocId from './parsefunction/generateCertificatebydocId.js';
import fileUpload from './parsefunction/fileUpload.js';
import getUserListByOrg from './parsefunction/getUserListByOrg.js';
import editContact from './parsefunction/editContact.js';
import forwardDoc from './parsefunction/ForwardDoc.js';
import saveAsTemplate from './parsefunction/saveAsTemplate.js';
import updateTenant from './parsefunction/updateTenant.js';
import recreateDocument from './parsefunction/recreateDocument.js';
import addUser from './parsefunction/addUser.js';
import sendDeleteUserMail from './parsefunction/sendDeleteUserMail.js';
import resetPassword from './parsefunction/resetPassword.js';
import saveSignature from './parsefunction/saveSignature.js';
import getSignature from './parsefunction/getSignature.js';
import triggerEvent from './parsefunction/triggerEvent.js';
import setWidgetPreferences from './parsefunction/setWidgetPreferences.js';
import createDocumentFromApp from './parsefunction/createDocumentFromApp.js';
import sendreminder from './parsefunction/sendReminder.js';
import autoRemindersJob from './jobs/autoReminders.js';
import { aiAnalyzeDocument, aiPrepareDocument, aiStatus } from './parsefunction/aiFunctions.js';
import {
  generateApiToken,
  getApiToken,
  revokeApiTokenFn,
} from './parsefunction/apiTokenFunctions.js';
import {
  listOAuthGrantsFn,
  oauthDecide,
  oauthRequest,
  revokeOAuthGrantFn,
  setOAuthGrantSigningFn,
} from './parsefunction/oauthFunctions.js';
import { getAgentRulesFn, setAgentRulesFn } from './parsefunction/agentRulesFunctions.js';
import getSigningLinks from './parsefunction/getSigningLinks.js';
import savePlaceholders from './parsefunction/savePlaceholders.js';
import updateProfile from './parsefunction/updateProfile.js';
import updateTeamMember from './parsefunction/updateTeamMember.js';
import {
  getEmailVerification,
  sendEmailVerification,
  userBeforeSave,
  verifyEmail,
} from './parsefunction/emailVerification.js';
import { sendPasswordCode, setPasswordWithCode } from './parsefunction/setPasswordWithCode.js';
import {
  decideSignApproval,
  getSignApproval,
  getSignApprovalPage,
  listSignApprovals,
} from './parsefunction/approvalFunctions.js';

// This afterSave function triggers after an object is added or updated in the specified class, allowing for post-processing logic.
Parse.Cloud.afterSave('contracts_Document', DocumentAftersave);
Parse.Cloud.afterSave('contracts_Contactbook', ContactbookAftersave);
Parse.Cloud.afterSave('contracts_Template', TemplateAfterSave);
Parse.Cloud.afterSave('contracts_Teams', TeamsAftersave);

// This beforeSave function triggers before an object is added or updated in the specified class, allowing for validation or modification.
Parse.Cloud.beforeSave('contracts_Document', DocumentBeforesave);
Parse.Cloud.beforeSave('contracts_Template', TemplateBeforeSave);
// Freezes a user's email, username and emailVerified for every non-master write.
Parse.Cloud.beforeSave(Parse.User, userBeforeSave);

// This afterFind function triggers after a query retrieves objects from the specified class, allowing for post-processing of the results.
Parse.Cloud.afterFind(Parse.User, UserAfterFind);
Parse.Cloud.afterFind('contracts_Document', DocumentBeforeFind);
Parse.Cloud.afterFind('contracts_Template', TemplateAfterFind);
Parse.Cloud.afterFind('contracts_Signature', SignatureAfterFind);
Parse.Cloud.afterFind('partners_Tenant', TenantAterFind);

// This define function creates a custom Cloud Function that can be called from the client-side, enabling custom business logic on the server.
Parse.Cloud.define('signPdf', PDF);
Parse.Cloud.define('sendmailv3', sendmailv3);
Parse.Cloud.define('usersignup', usersignup);
Parse.Cloud.define('SendOTPMailV1', sendMailOTPv1);
Parse.Cloud.define('AuthLoginAsMail', AuthLoginAsMail);
Parse.Cloud.define('getUserDetails', getUserDetails);
Parse.Cloud.define('getDocument', getDocument);
Parse.Cloud.define('getReport', getReport);
Parse.Cloud.define('getTemplate', GetTemplate);
Parse.Cloud.define('getsignedurl', getSignedUrl);
Parse.Cloud.define('batchdocuments', createBatchDocs);
Parse.Cloud.define('linkcontacttodoc', linkContactToDoc);
Parse.Cloud.define('getlogobydomain', GetLogoByDomain);
Parse.Cloud.define('addadmin', AddAdmin);
Parse.Cloud.define('checkadminexist', CheckAdminExist);
Parse.Cloud.define('getteams', getTeams);
Parse.Cloud.define('getcontact', getContact);
Parse.Cloud.define('declinedoc', declinedocument);
Parse.Cloud.define('gettenant', getTenant);
Parse.Cloud.define('getsigners', getSigners);
Parse.Cloud.define('savecontact', savecontact);
Parse.Cloud.define('updatesignaturetype', updateSignatureType);
Parse.Cloud.define('updatepreferences', updatePreferences);
Parse.Cloud.define('createduplicate', createDuplicate);
Parse.Cloud.define('generatecertificate', generateCertificatebydocId);
Parse.Cloud.define('fileupload', fileUpload);
Parse.Cloud.define('getuserlistbyorg', getUserListByOrg);
Parse.Cloud.define('editcontact', editContact);
Parse.Cloud.define('forwarddoc', forwardDoc);
Parse.Cloud.define('saveastemplate', saveAsTemplate);
Parse.Cloud.define('updatetenant', updateTenant);
Parse.Cloud.define('recreatedoc', recreateDocument);
Parse.Cloud.define('adduser', addUser);
Parse.Cloud.define('senddeleterequest', sendDeleteUserMail);
Parse.Cloud.define('resetpassword', resetPassword);
Parse.Cloud.define('savesignature', saveSignature);
Parse.Cloud.define('getdefaultsignature', getSignature);
Parse.Cloud.define('triggerevent', triggerEvent);
Parse.Cloud.define('getdocumentopens', getDocumentOpens);
Parse.Cloud.define('setwidgetpreferences', setWidgetPreferences);
Parse.Cloud.define('createdocumentfromapp', createDocumentFromApp);
Parse.Cloud.define('sendreminder', sendreminder);
// Storage accounting: the only writer of partners_DataFiles / partners_TenantCredits.
Parse.Cloud.define('recordfileusage', recordFileUsage);
// AI document preparation (Claude on Bedrock) and personal API tokens.
Parse.Cloud.define('aistatus', aiStatus);
Parse.Cloud.define('aianalyzedocument', aiAnalyzeDocument);
Parse.Cloud.define('aipreparedocument', aiPrepareDocument);
Parse.Cloud.define('generateapitoken', generateApiToken);
Parse.Cloud.define('revokeapitoken', revokeApiTokenFn);
Parse.Cloud.define('getapitoken', getApiToken);
// "Sign in with DocuStamp" for MCP clients: the consent page and connected apps.
Parse.Cloud.define('oauthrequest', oauthRequest);
Parse.Cloud.define('oauthdecide', oauthDecide);
Parse.Cloud.define('listoauthgrants', listOAuthGrantsFn);
Parse.Cloud.define('revokeoauthgrant', revokeOAuthGrantFn);
Parse.Cloud.define('setoauthgrantsigning', setOAuthGrantSigningFn);
// "Rules for your AI": what the user's agents may sign and send without asking.
Parse.Cloud.define('getagentrules', getAgentRulesFn);
Parse.Cloud.define('setagentrules', setAgentRulesFn);
// Access hardening: tokenised signing links, signer-side placeholder save,
// and the contracts_Users writes the web app used to do over the open REST class.
Parse.Cloud.define('getsigninglinks', getSigningLinks);
Parse.Cloud.define('saveplaceholders', savePlaceholders);
Parse.Cloud.define('updateprofile', updateProfile);
Parse.Cloud.define('updateteammember', updateTeamMember);
// Proving the account's own email address with an emailed code.
Parse.Cloud.define('getemailverification', getEmailVerification);
Parse.Cloud.define('sendemailverification', sendEmailVerification);
Parse.Cloud.define('verifyemail', verifyEmail);
// Setting a password with an emailed code, for accounts that never had one.
Parse.Cloud.define('sendpasswordcode', sendPasswordCode);
Parse.Cloud.define('setpasswordwithcode', setPasswordWithCode);
// Approving a signature an AI agent asked to make on a document sent to the user.
Parse.Cloud.define('listsignapprovals', listSignApprovals);
Parse.Cloud.define('getsignapproval', getSignApproval);
Parse.Cloud.define('getsignapprovalpage', getSignApprovalPage);
Parse.Cloud.define('decidesignapproval', decideSignApproval);

// Background jobs.
Parse.Cloud.job('autoReminders', autoRemindersJob);

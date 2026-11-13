import { i18n } from '@/modules/i18n';
import enForeman from '@/modules/i18n/locales/en/foreman.json';

/** The i18n namespace of everything in the Foreman tab. */
export const FOREMAN_NAMESPACE = 'foreman';

/** The label key of the tab itself, for the workspace tab menu (it lives outside this module). */
export const FOREMAN_TAB_LABEL_KEY = `${FOREMAN_NAMESPACE}:tabs.title`;

// The English catalog is registered here, next to the code that uses it, so the shared i18n config stays untouched.
// Other languages fall back to English (`fallbackLng`).
if (!i18n.hasResourceBundle('en', FOREMAN_NAMESPACE)) {
  i18n.addResourceBundle('en', FOREMAN_NAMESPACE, enForeman, true, true);
}

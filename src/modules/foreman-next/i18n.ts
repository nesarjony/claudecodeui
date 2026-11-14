import { i18n } from '@/modules/i18n';
import enForemanNext from '@/modules/i18n/locales/en/foremanNext.json';

// The English catalog is registered here, next to the code that uses it, so the shared i18n config stays untouched.
// Other languages fall back to English (`fallbackLng`).
if (!i18n.hasResourceBundle('en', 'foremanNext')) {
  i18n.addResourceBundle('en', 'foremanNext', enForemanNext, true, true);
}

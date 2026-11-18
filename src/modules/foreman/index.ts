// ForemanPanel: rendered by the workspace (WorkspaceMain) for the "Foreman" tab.
// FOREMAN_TAB_LABEL_KEY: the tab's label key for the workspace tab menu. Importing it also registers the module's
// English catalog, so the menu can translate the label before the panel itself is ever opened.
export { default as ForemanPanel } from '@/modules/foreman/ForemanPanel';
export { FOREMAN_TAB_LABEL_KEY } from '@/modules/foreman/i18n';
// isForemanTabAvailable: false in the build made for the rebuilt Foreman, which has no old tab.
// areForemanSuggestionsAvailable: the same for the "Foreman suggests" card and its Quick Settings switch.
export { areForemanSuggestionsAvailable, isForemanTabAvailable } from '@/modules/foreman/tabAvailability';

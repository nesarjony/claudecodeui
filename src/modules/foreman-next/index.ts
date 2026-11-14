// ForemanNextRoutes: the app router mounts it under `/foreman/*` when FOREMAN_NEXT_ENABLED.
// ForemanSessionBar: the project-workspace session view renders it to hand a session to Foreman and to take it back.
export { ForemanNextRoutes } from '@/modules/foreman-next/ForemanNextRoutes';
export { ForemanSessionBar } from '@/modules/foreman-next/handover/ForemanSessionBar';
export { FOREMAN_NEXT_ENABLED } from '@/modules/foreman-next/api/createForemanApi';

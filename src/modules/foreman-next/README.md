# foreman-next

The control UI of the rebuilt Foreman (slice 4a): `/foreman` screens, hand-over in the session view, and a sidebar link. The old Foreman tab (`src/modules/foreman`) stays in the code, and a build with `VITE_FOREMAN_NEXT_API=real` hides it (`src/modules/foreman/tabAvailability.ts`).

- **Flag, build time.** `VITE_FOREMAN_NEXT_API` is `mock` or `real`. Unset, nothing of this module is in the bundle (the routes, the session bar and the sidebar link are lazy chunks behind the literal flag; the mock sits behind a literal `=== 'mock'`). See `.env.example`.
- **Contract first.** `api/contract/` holds the types and the endpoint list, in the module and not in `src/shared/` (an exception to the frontend skill): the contract is Foreman's API and is written before the backend. Screens depend on it only; `api/mock/` and `api/realClient.ts` are its two implementations.
- **Base path and envelope.** `/api/foreman-next` on cloudcli's origin. cloudcli proxies to Foreman, which stays local-only, and serves `/service-log` itself: the last lines of `journalctl --user -u foreman-next` (spawned without a shell, capped, bearer tokens and keys taken out), or of `FOREMAN_NEXT_LOG_FILE` when that names a file (a test instance); with no journal it says so. The proxy adds `{ success, data }` and `{ success: false, error: { code, message } }`, so Foreman's own API stays plain.
- **`DelegationKind` stays separate from the ledger's `DecisionKind`.** Foreman owns the classification; `delegationKind` is nullable on questions, history entries and decision records.
- **Loading.** Routes, the shell, the chat drawer and modals load with `useForemanResource`; panels, cards and rows receive data and only call actions through `useAction`.
- **Polling.** One clock (`hooks/refreshClock.ts`) refreshes every loaded resource together, pauses while the tab is hidden, and a resource stops polling when its data says nothing more will change (`keepPolling`). Every successful action refreshes everything. Slice 4b adds a stream behind the same hook.
- **Order.** Foreman returns owner questions most rows held first; the UI does not sort.

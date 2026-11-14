# Foreman control UI (slice 4a): browser evidence

Text snapshots only, no screenshots. Taken with `agent-browser` (headless Chrome) against the Vite dev server on `127.0.0.1:5199`,
started with `VITE_FOREMAN_NEXT_API=mock`, so every screen is served by the mock client. The `scenario` query parameter bends the mock
into a special state. `/api` pointed at a local stub that answers only the three auth endpoints, so nothing reached the live instance.
Each entry has the interactive snapshot (`snapshot -i -c`) and the visible text of the page (`get text body`).

## 1. Today: the briefing

Wireframes §4. URL `/foreman`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e18]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e19]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e20]
    - link "Details" [ref=e21]
    - button "Looks right" [ref=e27]
    - button "Looks right" [ref=e28]
    - button "Looks right" [ref=e29]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e22]
    - link "desk · Inbox" [ref=e30]
    - link "desk · Contacts" [ref=e31]
    - link "desk · Conversation" [ref=e32]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e23]
    - link "Watch" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Watch" [ref=e35]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e24]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:31 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:19 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:11 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0

```

## 2. Decide > Needs you: the decision card

Wireframes §5a. URL `/foreman/decide`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e15]
    - link "Review" [ref=e16]
    - link "History" [ref=e17]
  - article "Bulk actions in v1?" [ref=e13]
    - heading "Bulk actions in v1?" [level=2, ref=e24]
    - link "Settings › Delegation" [ref=e38]
    - heading "What's going on" [level=3, ref=e25]
    - columnheader "Options" [ref=e70]
    - columnheader "Rows now" [ref=e71]
    - columnheader "Cost" [ref=e72]
    - columnheader "Risk" [ref=e73]
    - rowheader "AAll three: assign, close, tag recommended" [ref=e39]
    - cell "+20" [ref=e40]
    - cell "+1 endpoint" [ref=e41]
    - cell "low" [ref=e42]
    - rowheader "BAssign and close; tag later" [ref=e43]
    - cell "+14" [ref=e44]
    - cell "6 deferred" [ref=e45]
    - cell "low" [ref=e46]
    - rowheader "CNone in v1" [ref=e47]
    - cell "0" [ref=e48]
    - cell "20 deferred" [ref=e49]
    - cell "visible parity gap" [ref=e50]
    - region "Recommendation" [ref=e18]
    - button "A: All three: assign, close, tag" [ref=e51]
    - button "B: Assign and close; tag later" [ref=e52]
    - button "C: None in v1" [ref=e53]
    - textbox "or reply:" [ref=e26]
    - button "Send" [disabled, ref=e27]
    - checkbox "Remember as a rule" [checked=true, ref=e19]
    - radio "desk" [checked=true, ref=e28]
    - radio "this goal" [checked=false, ref=e29]
    - radio "all repos" [checked=false, ref=e30]
    - checkbox "Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)" [checked=false, ref=e20]
  - article "Realtime transport" [ref=e14]
    - heading "Realtime transport" [level=2, ref=e31]
    - link "Settings › Delegation" [ref=e54]
    - heading "What's going on" [level=3, ref=e32]
    - columnheader "Options" [ref=e74]
    - columnheader "Rows now" [ref=e75]
    - columnheader "Cost" [ref=e76]
    - columnheader "Risk" [ref=e77]
    - rowheader "AWebSocket" [ref=e55]
    - cell "+15" [ref=e56]
    - cell "+1 service" [ref=e57]
    - cell "medium" [ref=e58]
    - rowheader "BServer-sent events recommended" [ref=e59]
    - cell "+15" [ref=e60]
    - cell "no new service" [ref=e61]
    - cell "low" [ref=e62]
    - rowheader "CPolling" [ref=e63]
    - cell "+9" [ref=e64]
    - cell "6 deferred" [ref=e65]
    - cell "visible lag" [ref=e66]
    - region "Recommendation" [ref=e21]
    - button "A: WebSocket" [ref=e67]
    - button "B: Server-sent events" [ref=e68]
    - button "C: Polling" [ref=e69]
    - textbox "or reply:" [ref=e33]
    - button "Send" [disabled, ref=e34]
    - checkbox "Remember as a rule" [checked=true, ref=e22]
    - radio "desk" [checked=true, ref=e35]
    - radio "this goal" [checked=false, ref=e36]
    - radio "all repos" [checked=false, ref=e37]
    - checkbox "Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)" [checked=false, ref=e23]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History
Bulk actions in v1?

Product scope · holds 20 rows · asked 2h ago

Why it's yours: product scope questions are set to "Ask me" Settings › Delegation

What's going on

Libredesk's list supports bulk assign, bulk close and bulk tag. Inbox rows 88-94 and 97-109 depend on which of these desk ships in v1.

Options
Options	Rows now	Cost	Risk
AAll three: assign, close, tagrecommended	+20	+1 endpoint	low
BAssign and close; tag later	+14	6 deferred	low
CNone in v1	0	20 deferred	visible parity gap

Foreman recommends A
confidence 0.7

You decided "parity first, defer nothing visible" on 11-02, and chose the full option in 3 similar cases.

↗ similar decisions (3)

If you don't answer: t3-bulk stays held. Nothing else waits on this.

A
B
C
or reply:
Send
Remember as a rule
scope
scope
desk
this goal
all repos
Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)
Realtime transport

Product scope · holds 15 rows · asked 2h ago

Why it's yours: product scope questions are set to "Ask me" Settings › Delegation

What's going on

Live updates in the conversation list can use WebSocket or server-sent events. Rows 110-124 differ by transport.

Options
Options	Rows now	Cost	Risk
AWebSocket	+15	+1 service	medium
BServer-sent eventsrecommended	+15	no new service	low
CPolling	+9	6 deferred	visible lag

Foreman recommends B
confidence 0.6

Libredesk streams over server-sent events, and you kept the donor mechanism in 2 of 3 similar cases.

↗ similar decisions (2)

If you don't answer: Rows 110-124 stay held. The batches before them keep running.

A
B
C
or reply:
Send
Remember as a rule
scope
scope
desk
this goal
all repos
Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)

```

## 3. Decide > Needs you: one decision, deep-linked

Wireframes §5a. URL `/foreman/decide/needs/q-realtime`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e15]
    - link "Review" [ref=e16]
    - link "History" [ref=e17]
  - link "◂ All decisions" [ref=e13]
  - article "Realtime transport" [ref=e14]
    - heading "Realtime transport" [level=2, ref=e21]
    - link "Settings › Delegation" [ref=e28]
    - heading "What's going on" [level=3, ref=e22]
    - columnheader "Options" [ref=e44]
    - columnheader "Rows now" [ref=e45]
    - columnheader "Cost" [ref=e46]
    - columnheader "Risk" [ref=e47]
    - rowheader "AWebSocket" [ref=e29]
    - cell "+15" [ref=e30]
    - cell "+1 service" [ref=e31]
    - cell "medium" [ref=e32]
    - rowheader "BServer-sent events recommended" [ref=e33]
    - cell "+15" [ref=e34]
    - cell "no new service" [ref=e35]
    - cell "low" [ref=e36]
    - rowheader "CPolling" [ref=e37]
    - cell "+9" [ref=e38]
    - cell "6 deferred" [ref=e39]
    - cell "visible lag" [ref=e40]
    - region "Recommendation" [ref=e18]
    - button "A: WebSocket" [ref=e41]
    - button "B: Server-sent events" [ref=e42]
    - button "C: Polling" [ref=e43]
    - textbox "or reply:" [ref=e23]
    - button "Send" [disabled, ref=e24]
    - checkbox "Remember as a rule" [checked=true, ref=e19]
    - radio "desk" [checked=true, ref=e25]
    - radio "this goal" [checked=false, ref=e26]
    - radio "all repos" [checked=false, ref=e27]
    - checkbox "Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)" [checked=false, ref=e20]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History
◂ All decisions
Realtime transport

Product scope · holds 15 rows · asked 2h ago

Why it's yours: product scope questions are set to "Ask me" Settings › Delegation

What's going on

Live updates in the conversation list can use WebSocket or server-sent events. Rows 110-124 differ by transport.

Options
Options	Rows now	Cost	Risk
AWebSocket	+15	+1 service	medium
BServer-sent eventsrecommended	+15	no new service	low
CPolling	+9	6 deferred	visible lag

Foreman recommends B
confidence 0.6

Libredesk streams over server-sent events, and you kept the donor mechanism in 2 of 3 similar cases.

↗ similar decisions (2)

If you don't answer: Rows 110-124 stay held. The batches before them keep running.

A
B
C
or reply:
Send
Remember as a rule
scope
scope
desk
this goal
all repos
Let Foreman decide product scope questions like this one (moves it up the trust ladder, see Settings)

```

## 4. Decide > Review: veto windows

Wireframes §5b. URL `/foreman/decide/review`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e13]
    - link "Review" [ref=e14]
    - link "History" [ref=e15]
  - button "Details" [expanded=false, ref=e16]
  - button "Veto" [ref=e17]
  - button "OK" [ref=e18]
  - button "Details" [expanded=false, ref=e19]
  - button "Veto" [ref=e20]
  - button "OK" [ref=e21]
  - button "Details" [expanded=false, ref=e22]
  - button "Veto" [ref=e23]
  - button "OK" [ref=e24]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History

Foreman decided these alone. Each one stays open to veto until its window closes.

●Adopted rule hooks/state-reset in desk

E7 · +18 points over 12 rows

closes 15:31 · in 3h 11m
Details
Veto
OK

●New lesson: all UI copy comes from i18n

from 2 judge failures

closes 19:19 · in 6h 59m
Details
Veto
OK

●Re-planned desk · Inbox (strategy v2)

after your scope answer

closes 13:11 · in 51m
Details
Veto
OK

OK closes an item early. Veto undoes the change and records why, so Foreman learns from it.

```

## 5. Decide > Review: veto asks why

Wireframes §5b, BR-4.8. URL `/foreman/decide/review`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e13]
    - link "Review" [ref=e14]
    - link "History" [ref=e15]
  - button "Details" [expanded=false, ref=e16]
  - button "Veto" [ref=e17]
  - button "OK" [ref=e18]
  - textbox "Why are you vetoing this?" [ref=e25]
  - button "Veto and record why" [disabled, ref=e26]
  - button "Cancel" [ref=e27]
  - button "Details" [expanded=false, ref=e19]
  - button "Veto" [ref=e20]
  - button "OK" [ref=e21]
  - button "Details" [expanded=false, ref=e22]
  - button "Veto" [ref=e23]
  - button "OK" [ref=e24]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History

Foreman decided these alone. Each one stays open to veto until its window closes.

●Adopted rule hooks/state-reset in desk

E7 · +18 points over 12 rows

closes 15:31 · in 3h 11m
Details
Veto
OK
Why are you vetoing this?
Veto and record why
Cancel

●New lesson: all UI copy comes from i18n

from 2 judge failures

closes 19:19 · in 6h 59m
Details
Veto
OK

●Re-planned desk · Inbox (strategy v2)

after your scope answer

closes 13:11 · in 51m
Details
Veto
OK

OK closes an item early. Veto undoes the change and records why, so Foreman learns from it.

```

## 6. Decide > History

Wireframes §5. URL `/foreman/decide/history`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e13]
    - link "Review" [ref=e14]
    - link "History" [ref=e15]
  - link "Steer at turn 9 · t2-layout" [ref=e16]
  - link "Which languages ship in v1?" [ref=e17]
  - link "Re-plan Inbox after the scope answer" [ref=e18]
  - link "CSV export of conversations" [ref=e19]
  - link "Session handling" [ref=e20]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History
Steer at turn 9 · t2-layout

desk · Inbox · Nov 14 · Steer

Foreman
Which languages ship in v1?

desk · Inbox · Nov 13 · English only

you
you agreed
Re-plan Inbox after the scope answer

desk · Inbox · Nov 13 · Re-plan

Foreman
CSV export of conversations

desk · Inbox · Nov 9 · Full option

you
you agreed
Session handling

desk · Inbox · Nov 6 · Donor

you
you chose differently

```

## 7. Decision card (what Foreman saw, used, considered, chose)

Wireframes §7. URL `/foreman/decisions/dec-steer-9`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decision card" [level=1, ref=e11]
  - link "◂ History" [ref=e12]
  - article "Steer at turn 9 · t2-layout" [ref=e13]
    - heading "Steer at turn 9 · t2-layout" [level=2, ref=e15]
    - link "↗ Trace" [ref=e16]
    - region "Your view" [ref=e14]
      - heading "Your view" [level=3, ref=e17]
      - button "Good" [ref=e18]
      - button "Bad" [ref=e19]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decision card
◂ History
Steer at turn 9 · t2-layout

supervisor v2 on Opus · $0.04 · 3.1s
↗ Trace

Saw
The worker added a second fetch in InboxLayout.tsx (+38 lines) while useConversationList already loads the same data.
Used
lesson "one data source per list" · desk convention: state management
Considered
continue (the duplicate fetch would reach the judge) · steer · ask you
Chose
steer: "Reuse useConversationList; don't add a second fetch."
Outcome
The worker removed the fetch at turn 10. Row 7 passed on the first try.
Your view
Good
Bad

A Bad with a correction becomes a test case, so this mistake can't quietly return.

```

## 8. Work: board

Wireframes §6a. URL `/foreman/work`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Work" [level=1, ref=e11]
  - radio "Board" [checked=true, ref=e17]
  - radio "List" [checked=false, ref=e18]
  - button "+ New goal" [ref=e12]
  - region "Waiting on you" [ref=e13]
    - heading "Waiting on you (1)" [level=2, ref=e19]
    - link "desk · Inbox 65/120 · ~Tue 2 decisions hold 35" [ref=e23]
  - region "Active" [ref=e14]
    - heading "Active (2)" [level=2, ref=e20]
    - link "desk · Inbox batch 4 of 13 $11 to go" [ref=e24]
    - link "desk boss handed over turn 31 · 52m" [ref=e25]
  - region "Queued" [ref=e15]
    - heading "Queued (2)" [level=2, ref=e21]
    - link "desk · Contacts queued after Inbox no strategy yet" [ref=e26]
    - link "desk · Conversation queued after Contacts no strategy yet" [ref=e27]
  - region "Done" [ref=e16]
    - heading "Done (1)" [level=2, ref=e22]
    - link "scratch · demo 12/12 · 2 days $3.10" [ref=e28]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Work

Programme: desk parity, 47 screens

View
View
Board
List
+ New goal
Waiting on you (1)
desk · Inbox

65/120 · ~Tue

2 decisions hold 35

Active (2)
desk · Inbox

batch 4 of 13

$11 to go

desk boss
handed over

turn 31 · 52m

Queued (2)
desk · Contacts

queued after Inbox

no strategy yet

desk · Conversation

queued after Contacts

no strategy yet

Done (1)
scratch · demo

12/12 · 2 days

$3.10

```

## 9. Work: list view

Wireframes §6a. URL `/foreman/work?view=list`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Work" [level=1, ref=e11]
  - radio "Board" [checked=false, ref=e13]
  - radio "List" [checked=true, ref=e14]
  - button "+ New goal" [ref=e12]
  - columnheader "Goal" [ref=e35]
  - columnheader "State" [ref=e36]
  - columnheader "Progress" [ref=e37]
  - columnheader "Spent" [ref=e38]
  - columnheader "Waiting on you" [ref=e39]
  - rowheader "desk · Inbox" [ref=e15]
    - link "desk · Inbox" [ref=e40]
  - cell "active" [ref=e16]
  - cell "65/120" [ref=e17]
  - cell "$12.40" [ref=e18]
  - cell "2 decisions hold 35" [ref=e19]
  - rowheader "desk · Contacts" [ref=e20]
    - link "desk · Contacts" [ref=e41]
  - cell "queued" [ref=e21]
  - cell "0/96" [ref=e22]
  - cell "$0.00" [ref=e23]
  - rowheader "desk · Conversation" [ref=e24]
    - link "desk · Conversation" [ref=e42]
  - cell "queued" [ref=e25]
  - cell "0/140" [ref=e26]
  - cell "$0.00" [ref=e27]
  - rowheader "scratch · demo" [ref=e28]
    - link "scratch · demo" [ref=e43]
  - cell "done" [ref=e29]
  - cell "12/12" [ref=e30]
  - cell "$3.10" [ref=e31]
  - rowheader "desk boss" [ref=e32]
    - link "desk boss" [ref=e44]
  - cell "handed over" [ref=e33]
  - cell "turn 31 · 52m" [ref=e34]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Work

Programme: desk parity, 47 screens

View
View
Board
List
+ New goal
Goal	State	Progress	Spent	Waiting on you
desk · Inbox	active	65/120	$12.40	2 decisions hold 35
desk · Contacts	queued	0/96	$0.00	
desk · Conversation	queued	0/140	$0.00	
scratch · demo	done	12/12	$3.10	
desk boss	handed over	turn 31 · 52m		

```

## 10. Work: New goal dialog

Wireframes §14. URL `/foreman/work`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Work" [level=1, ref=e11]
  - radio "Board" [checked=true, ref=e17]
  - radio "List" [checked=false, ref=e18]
  - button "+ New goal" [ref=e12]
  - region "Waiting on you" [ref=e13]
    - heading "Waiting on you (1)" [level=2, ref=e19]
    - link "desk · Inbox 65/120 · ~Tue 2 decisions hold 35" [ref=e28]
  - region "Active" [ref=e14]
    - heading "Active (2)" [level=2, ref=e20]
    - link "desk · Inbox batch 4 of 13 $11 to go" [ref=e29]
    - link "desk boss handed over turn 31 · 52m" [ref=e30]
  - region "Queued" [ref=e15]
    - heading "Queued (2)" [level=2, ref=e21]
    - link "desk · Contacts queued after Inbox no strategy yet" [ref=e31]
    - link "desk · Conversation queued after Contacts no strategy yet" [ref=e32]
  - region "Done" [ref=e16]
    - heading "Done (1)" [level=2, ref=e22]
    - link "scratch · demo 12/12 · 2 days $3.10" [ref=e33]
- heading "New goal" [level=2, ref=e23]
- textbox "Repo" [ref=e24]
- textbox "Goal" [ref=e25]
- button "Cancel" [ref=e26]
- button "Create goal" [disabled, ref=e27]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Work

Programme: desk parity, 47 screens

View
View
Board
List
+ New goal
Waiting on you (1)
desk · Inbox

65/120 · ~Tue

2 decisions hold 35

Active (2)
desk · Inbox

batch 4 of 13

$11 to go

desk boss
handed over

turn 31 · 52m

Queued (2)
desk · Contacts

queued after Inbox

no strategy yet

desk · Conversation

queued after Contacts

no strategy yet

Done (1)
scratch · demo

12/12 · 2 days

$3.10

New goal
Repo
Goal

Foreman then studies the repo and proposes a strategy for you to approve.

Cancel
Create goal

```

## 11. Goal page

Wireframes §6b. URL `/foreman/work/g-inbox`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - link "◂ Work" [ref=e11]
  - heading "desk · Inbox at 100% Libredesk parity" [level=1, ref=e15]
  - button "Pause" [ref=e16]
  - button "Re-plan" [ref=e17]
  - region "Progress" [ref=e12]
    - heading "Progress" [level=2, ref=e19]
  - region "Strategy v2" [ref=e13]
    - heading "Strategy v2" [level=2, ref=e20]
    - button "Compare v1" [expanded=false, ref=e21]
  - region "Batches" [ref=e14]
    - heading "Batches" [level=2, ref=e22]
    - link "Open" [ref=e23]
    - link "Watch" [ref=e24]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
    - button "All 13 batches" [expanded=false, ref=e18]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
◂ Work
desk · Inbox at 100% Libredesk parity
active
Pause
Re-plan

Done when: all 120 checklist rows are DONE and verified by the judge

Progress
DONE 65
BUILT 3
TODO 52

Forecast about 9 more batches · $11 of API credit · 4 MiniMax windows · done around Tue (likely)

Spent $12.40 of the $40 share · first-pass yield 91% · $0.38 per DONE row

Strategy v2
re-planned 09:19 · after your scope answer
Compare v1
Fix batch first: rows 42, 76, 79, held from the earlier run
Contract batch: the 5 missing endpoints, before rows that use them
Layout, then components, then integration

Risk: realtime rows wait on your transport decision · 33 rows have no donor tests

Batches
✓
✓
✓
●
◌
○
◌
○
○
○
○
○
○
3
t1-status-filter
10 rows
✓
9 of 10 first pass
$0.88
Open
4
t2-layout
6 rows
●
worker · turn 14
$0.20
Watch
5
t3-bulk
20 rows
◌
waits on: Bulk actions in v1?
Decide
6
t4-list-items
6 rows
○
queued
7
t5-realtime
15 rows
◌
waits on: Realtime transport
Decide
All 13 batches

```

## 12. Goal page: all batches

Wireframes §6b. URL `/foreman/work/g-inbox`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - link "◂ Work" [ref=e11]
  - heading "desk · Inbox at 100% Libredesk parity" [level=1, ref=e15]
  - button "Pause" [ref=e16]
  - button "Re-plan" [ref=e17]
  - region "Progress" [ref=e12]
    - heading "Progress" [level=2, ref=e19]
  - region "Strategy v2" [ref=e13]
    - heading "Strategy v2" [level=2, ref=e20]
    - button "Compare v1" [expanded=false, ref=e21]
  - region "Batches" [ref=e14]
    - heading "Batches" [level=2, ref=e22]
    - link "Open" [ref=e23]
    - link "Watch" [ref=e24]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
    - button "Fewer batches" [expanded=true, ref=e18]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
◂ Work
desk · Inbox at 100% Libredesk parity
active
Pause
Re-plan

Done when: all 120 checklist rows are DONE and verified by the judge

Progress
DONE 65
BUILT 3
TODO 52

Forecast about 9 more batches · $11 of API credit · 4 MiniMax windows · done around Tue (likely)

Spent $12.40 of the $40 share · first-pass yield 91% · $0.38 per DONE row

Strategy v2
re-planned 09:19 · after your scope answer
Compare v1
Fix batch first: rows 42, 76, 79, held from the earlier run
Contract batch: the 5 missing endpoints, before rows that use them
Layout, then components, then integration

Risk: realtime rows wait on your transport decision · 33 rows have no donor tests

Batches
✓
✓
✓
●
◌
○
◌
○
○
○
○
○
○
1
t0-fixes
3 rows
✓
3 of 3 first pass
$0.31
2
t0b-contract
5 rows
✓
5 of 5 first pass
$0.52
3
t1-status-filter
10 rows
✓
9 of 10 first pass
$0.88
Open
4
t2-layout
6 rows
●
worker · turn 14
$0.20
Watch
5
t3-bulk
20 rows
◌
waits on: Bulk actions in v1?
Decide
6
t4-list-items
6 rows
○
queued
7
t5-realtime
15 rows
◌
waits on: Realtime transport
Decide
8
t6-filters
6 rows
○
queued
9
t7-search
6 rows
○
queued
10
t8-assign
6 rows
○
queued
11
t9-tags
6 rows
○
queued
12
t10-polish
6 rows
○
queued
13
t11-integration
6 rows
○
queued
Fewer batches

```

## 13. Run view: live run

Wireframes §6c. URL `/foreman/work/runs/run-t2`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "t2-layout" [level=1, ref=e11]
  - region "Run" [ref=e12]
    - heading "Run" [level=2, ref=e22]
    - link "◂ desk · Inbox" [ref=e23]
    - button "Pause" [ref=e16]
    - button "Stop" [ref=e17]
    - button "Take over ↗" [ref=e18]
    - combobox "Replay from step..." [expanded=false, ref=e19]
      - option "Replay from step..." [selected, ref=e27]
      - option "Brief" [ref=e28]
      - option "Worker" [ref=e29]
      - option "Checks" [ref=e30]
      - option "Judge" [ref=e31]
      - option "Close" [ref=e32]
    - button "Replay" [disabled, ref=e20]
  - region "Foreman decisions" [ref=e13]
    - heading "Foreman decisions" [level=2, ref=e24]
    - link "Card" [ref=e33]
  - region "Worker" [ref=e14]
    - heading "Worker" [level=2, ref=e25]
    - link "Open session ↗" [ref=e21]
  - region "Checks and verdict · after the worker finishes" [ref=e15]
    - heading "Checks and verdict · after the worker finishes" [level=2, ref=e26]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
t2-layout
Run
MiniMax-M3 · sandboxed · turn 14 · 23m · MiniMax 3% of the 5h window

◂ desk · Inbox / t2-layout

Brief
✓
──▸
Worker
●
──▸
Checks
○
──▸
Judge
○
──▸
Close
○

Next Opus check: when the worker says done, asks something, or goes 10 turns without a commit

Pause
Stop
Take over ↗
Replay from step...
Brief
Worker
Checks
Judge
Close
Replay
Foreman decisions
turn 1
continue
rules
turn 5
continue
rules
turn 9
steer
Opus · $0.04
Card

"Reuse useConversationList; don't add a second fetch."

turn 14
continue
rules
Worker
now
editing InboxLayout.tsx
changed
4 files · +212 −31
tools
Read, Edit, Bash(pnpm test)
says
rows 4 and 7 built (informational only)
Open session ↗
Checks and verdict · after the worker finishes

The checks and the judge run after the worker finishes.

```

## 14. Run view: finished run with checks and verdict

Wireframes §6c. URL `/foreman/work/runs/run-t1`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "t1-status-filter" [level=1, ref=e11]
  - region "Run" [ref=e12]
    - heading "Run" [level=2, ref=e19]
    - link "◂ desk · Inbox" [ref=e20]
    - combobox "Replay from step..." [expanded=false, ref=e16]
      - option "Replay from step..." [selected, ref=e26]
      - option "Brief" [ref=e27]
      - option "Worker" [ref=e28]
      - option "Checks" [ref=e29]
      - option "Judge" [ref=e30]
      - option "Close" [ref=e31]
    - button "Replay" [disabled, ref=e17]
  - region "Foreman decisions" [ref=e13]
    - heading "Foreman decisions" [level=2, ref=e21]
  - region "Worker" [ref=e14]
    - heading "Worker" [level=2, ref=e22]
    - link "Open session ↗" [ref=e18]
  - region "Checks and verdict · after the worker finishes" [ref=e15]
    - heading "Checks and verdict · after the worker finishes" [level=2, ref=e23]
    - link "Output ↗" [ref=e24]
    - link "Verdict ↗" [ref=e25]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
t1-status-filter
Run
MiniMax-M3 · sandboxed · turn 22 · 47m · MiniMax 0% of the 5h window

◂ desk · Inbox / t1-status-filter

Brief
✓
──▸
Worker
✓
──▸
Checks
✓
──▸
Judge
✓
──▸
Close
✓

Next Opus check: the run is closed

Replay from step...
Brief
Worker
Checks
Judge
Close
Replay
Foreman decisions
turn 22
pass
Opus · $0.12
Worker

The worker has finished.

Open session ↗
Checks and verdict · after the worker finishes
Checks
pnpm verify exit 0, run by Foreman in a clean copy
Output ↗
Judge
row 4
✓
row 7
✓
row 81
✓
row 82
✓
row 83
✗
header 8px taller
row 84
✓
Verdict ↗
Next
row 83 goes back to the worker with the judge's reason

```

## 15. Run view: handed-over session (BR-2.10)

Wireframes §6c, BR-2.10. URL `/foreman/work/runs/run-ho-boss`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "desk boss" [level=1, ref=e11]
  - region "Run" [ref=e12]
    - heading "Run" [level=2, ref=e19]
    - link "◂ Work" [ref=e20]
    - button "Pause" [ref=e16]
    - button "Take back" [ref=e17]
  - region "Foreman decisions" [ref=e13]
    - heading "Foreman decisions" [level=2, ref=e21]
  - region "Session" [ref=e14]
    - heading "Session" [level=2, ref=e22]
    - link "Open session ↗" [ref=e18]
  - region "Checks and verdict · after the worker finishes" [ref=e15]
    - heading "Checks and verdict · after the worker finishes" [level=2, ref=e23]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
desk boss
Run
Opus · turn 31 · 52m

◂ Work / desk boss

Attach
✓
──▸
Worker
●
──▸
Checks
○
──▸
Judge
○
──▸
Close
○

Next Opus check: when the session says done, asks something, or goes 10 turns without a commit

Foreman is supervising your session desk boss, turn by turn. You can take it back at any time. Goal: finish the Contacts import.

Pause
Take back
Foreman decisions
turn 24
continue
rules
turn 31
continue
rules
Session
now
editing ContactImport.tsx
changed
3 files · +96 −12
tools
Read, Edit, Bash(pnpm test)
says
import mapping done, tests next (informational only)
Open session ↗
Checks and verdict · after the worker finishes

The checks and the judge run after the worker finishes.

```

## 16. Settings: delegation and attention policy

Wireframes §11, §13. URL `/foreman/settings`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Settings" [level=1, ref=e11]
  - region "Delegation · how much Foreman decides for you" [ref=e12]
    - heading "Delegation · how much Foreman decides for you" [level=2, ref=e15]
    - columnheader "Kind of decision" [ref=e66]
    - columnheader "Level" [ref=e67]
    - columnheader "You agreed" [ref=e68]
    - columnheader "Foreman suggests" [ref=e69]
    - rowheader "Product scope" [ref=e17]
    - cell "Ask me" [ref=e18]
      - combobox "Level for Product scope" [expanded=false, ref=e70]: Ask me
        - option "Ask me" [selected, ref=e106]
        - option "Recommend and wait" [ref=e107]
        - option "Decide, tell me" [ref=e108]
        - option "Decide silently" [ref=e109]
    - cell "11 of 12" [ref=e19]
    - cell "Move to \"Recommend and wait\" Approve" [ref=e20]
      - button "Approve" [ref=e71]
    - rowheader "Re-plan a goal" [ref=e21]
    - cell "Decide, tell me 6h veto" [ref=e22]
      - combobox "Level for Re-plan a goal" [expanded=false, ref=e72]: Decide, tell me
        - option "Ask me" [ref=e110]
        - option "Recommend and wait" [ref=e111]
        - option "Decide, tell me" [selected, ref=e112]
        - option "Decide silently" [ref=e113]
      - combobox "Veto window for Re-plan a goal" [expanded=false, ref=e73]: 6h veto
        - option "1h veto" [ref=e114]
        - option "2h veto" [ref=e115]
        - option "6h veto" [selected, ref=e116]
        - option "12h veto" [ref=e117]
        - option "24h veto" [ref=e118]
    - cell "9 of 9" [ref=e23]
    - cell "–" [ref=e24]
    - rowheader "Retry or re-plan a batch" [ref=e25]
    - cell "Decide silently" [ref=e26]
      - combobox "Level for Retry or re-plan a batch" [expanded=false, ref=e74]: Decide silently
        - option "Ask me" [ref=e119]
        - option "Recommend and wait" [ref=e120]
        - option "Decide, tell me" [ref=e121]
        - option "Decide silently" [selected, ref=e122]
    - cell "14 of 14" [ref=e27]
    - cell "–" [ref=e28]
    - rowheader "Raise a goal's budget share" [ref=e29]
    - cell "Ask me" [ref=e30]
      - combobox "Level for Raise a goal's budget share" [expanded=false, ref=e75]: Ask me
        - option "Ask me" [selected, ref=e123]
        - option "Recommend and wait" [ref=e124]
        - option "Decide, tell me" [ref=e125]
        - option "Decide silently" [ref=e126]
    - cell "3 of 4" [ref=e31]
    - cell "–" [ref=e32]
    - rowheader "Worker setup in a repo set in the lab phase" [ref=e33]
    - cell "Ask me" [ref=e34]
      - combobox "Level for Worker setup in a repo" [expanded=false, ref=e76]: Ask me
        - option "Ask me" [selected, ref=e127]
        - option "Recommend and wait" [ref=e128]
        - option "Decide, tell me" [ref=e129]
        - option "Decide silently" [ref=e130]
    - cell "–" [ref=e35]
    - cell "–" [ref=e36]
    - rowheader "Judge grading, scorecard, safety limits, budgets" [ref=e37]
    - cell "Owner only (locked)" [ref=e38]
    - cell "–" [ref=e39]
    - cell "–" [ref=e40]
  - region "Attention · what interrupts you" [ref=e13]
    - heading "Attention · what interrupts you" [level=2, ref=e16]
    - columnheader "Event" [ref=e77]
    - columnheader "Phone" [ref=e78]
    - columnheader "Morning briefing" [ref=e79]
    - columnheader "Log only" [ref=e80]
    - rowheader "A decision that blocks the critical path" [ref=e41]
    - cell "Now" [ref=e42]
      - combobox "Phone for: A decision that blocks the critical path" [expanded=false, ref=e81]: Now
        - option "Now" [selected, ref=e131]
        - option "After waiting" [ref=e132]
        - option "Never" [ref=e133]
    - cell "Morning briefing for: A decision that blocks the critical path" [ref=e43]
      - checkbox "Morning briefing for: A decision that blocks the critical path" [checked=false, ref=e82]
    - rowheader "A decision that blocks nothing urgent" [ref=e44]
    - cell "After waiting after 240 min" [ref=e45]
      - combobox "Phone for: A decision that blocks nothing urgent" [expanded=false, ref=e83]: After waiting
        - option "Now" [ref=e134]
        - option "After waiting" [selected, ref=e135]
        - option "Never" [ref=e136]
      - combobox "Phone delay for: A decision that blocks nothing urgent" [expanded=false, ref=e84]: after 240 min
        - option "after 30 min" [ref=e137]
        - option "after 60 min" [ref=e138]
        - option "after 120 min" [ref=e139]
        - option "after 240 min" [selected, ref=e140]
    - cell "Morning briefing for: A decision that blocks nothing urgent" [ref=e46]
      - checkbox "Morning briefing for: A decision that blocks nothing urgent" [checked=true, ref=e85]
    - rowheader "Paused by the budget ceiling or the MiniMax window" [ref=e47]
    - cell "Now" [ref=e48]
      - combobox "Phone for: Paused by the budget ceiling or the MiniMax window" [expanded=false, ref=e86]: Now
        - option "Now" [selected, ref=e141]
        - option "After waiting" [ref=e142]
        - option "Never" [ref=e143]
    - cell "Morning briefing for: Paused by the budget ceiling or the MiniMax window" [ref=e49]
      - checkbox "Morning briefing for: Paused by the budget ceiling or the MiniMax window" [checked=false, ref=e87]
    - rowheader "Work stuck and Foreman can't resolve it" [ref=e50]
    - cell "After waiting after 30 min" [ref=e51]
      - combobox "Phone for: Work stuck and Foreman can't resolve it" [expanded=false, ref=e88]: After waiting
        - option "Now" [ref=e144]
        - option "After waiting" [selected, ref=e145]
        - option "Never" [ref=e146]
      - combobox "Phone delay for: Work stuck and Foreman can't resolve it" [expanded=false, ref=e89]: after 30 min
        - option "after 30 min" [selected, ref=e147]
        - option "after 60 min" [ref=e148]
        - option "after 120 min" [ref=e149]
        - option "after 240 min" [ref=e150]
    - cell "Morning briefing for: Work stuck and Foreman can't resolve it" [ref=e52]
      - checkbox "Morning briefing for: Work stuck and Foreman can't resolve it" [checked=false, ref=e90]
    - rowheader "Something Foreman decided alone (Review)" [ref=e53]
    - cell "Never" [ref=e54]
      - combobox "Phone for: Something Foreman decided alone (Review)" [expanded=false, ref=e91]: Never
        - option "Now" [ref=e151]
        - option "After waiting" [ref=e152]
        - option "Never" [selected, ref=e153]
    - cell "Morning briefing for: Something Foreman decided alone (Review)" [ref=e55]
      - checkbox "Morning briefing for: Something Foreman decided alone (Review)" [checked=true, ref=e92]
    - rowheader "New lesson, batch finished, experiment result" [ref=e56]
    - cell "Never" [ref=e57]
      - combobox "Phone for: New lesson, batch finished, experiment result" [expanded=false, ref=e93]: Never
        - option "Now" [ref=e154]
        - option "After waiting" [ref=e155]
        - option "Never" [selected, ref=e156]
    - cell "Morning briefing for: New lesson, batch finished, experiment result" [ref=e58]
      - checkbox "Morning briefing for: New lesson, batch finished, experiment result" [checked=true, ref=e94]
    - rowheader "Routine turns and decisions" [ref=e59]
    - cell "Never" [ref=e60]
      - combobox "Phone for: Routine turns and decisions" [expanded=false, ref=e95]: Never
        - option "Now" [ref=e157]
        - option "After waiting" [ref=e158]
        - option "Never" [selected, ref=e159]
    - cell "Morning briefing for: Routine turns and decisions" [ref=e61]
      - checkbox "Morning briefing for: Routine turns and decisions" [checked=false, ref=e96]
    - cell "✓" [ref=e62]
    - spinbutton "Hours Hours" [ref=e97]: 11
    - spinbutton "Minutes Minutes" [ref=e98]: 0
    - spinbutton "AM/PM AM/PM" [ref=e99]: 2
    - button "Show time picker" [ref=e63]
    - spinbutton "Hours Hours" [ref=e100]: 8
    - spinbutton "Minutes Minutes" [ref=e101]: 0
    - spinbutton "AM/PM AM/PM" [ref=e102]: 1
    - button "Show time picker" [ref=e64]
    - spinbutton "Hours Hours" [ref=e103]: 8
    - spinbutton "Minutes Minutes" [ref=e104]: 0
    - spinbutton "AM/PM AM/PM" [ref=e105]: 1
    - button "Show time picker" [ref=e65]
    - button "Save" [ref=e14]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Settings
Delegation · how much Foreman decides for you
Kind of decision	Level	You agreed	Foreman suggests
Product scope	
Ask me
Recommend and wait
Decide, tell me
Decide silently
	11 of 12	
Move to "Recommend and wait"
Approve

Re-plan a goal	
Ask me
Recommend and wait
Decide, tell me
Decide silently
1h veto
2h veto
6h veto
12h veto
24h veto
	9 of 9	–
Retry or re-plan a batch	
Ask me
Recommend and wait
Decide, tell me
Decide silently
	14 of 14	–
Raise a goal's budget share	
Ask me
Recommend and wait
Decide, tell me
Decide silently
	3 of 4	–
Worker setup in a repo
set in the lab phase
	
Ask me
Recommend and wait
Decide, tell me
Decide silently
	–	–
Judge grading, scorecard, safety limits, budgets	Owner only (locked)	–	–

Levels: Ask me · Recommend and wait · Decide, tell me (veto window) · Decide silently

Foreman may suggest moving a kind up a level after 10 decisions with 90% agreement. You approve.

Attention · what interrupts you
Event	Phone	Morning briefing	Log only
A decision that blocks the critical path	
Now
After waiting
Never
		
A decision that blocks nothing urgent	
Now
After waiting
Never
after 30 min
after 60 min
after 120 min
after 240 min
		
Paused by the budget ceiling or the MiniMax window	
Now
After waiting
Never
		
Work stuck and Foreman can't resolve it	
Now
After waiting
Never
after 30 min
after 60 min
after 120 min
after 240 min
		
Something Foreman decided alone (Review)	
Now
After waiting
Never
		
New lesson, batch finished, experiment result	
Now
After waiting
Never
		
Routine turns and decisions	
Now
After waiting
Never
		✓
Quiet hours from
to
Briefing at

Quiet hours hold everything except stop events.

Save

```

## 17. Chat drawer opened with Ctrl+J on a goal

Wireframes §8. URL `/foreman/work/g-inbox`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=true, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - link "◂ Work" [ref=e11]
  - heading "desk · Inbox at 100% Libredesk parity" [level=1, ref=e15]
  - button "Pause" [ref=e16]
  - button "Re-plan" [ref=e17]
  - region "Progress" [ref=e12]
    - heading "Progress" [level=2, ref=e27]
  - region "Strategy v2" [ref=e13]
    - heading "Strategy v2" [level=2, ref=e28]
    - button "Compare v1" [expanded=false, ref=e29]
  - region "Batches" [ref=e14]
    - heading "Batches" [level=2, ref=e30]
    - link "Open" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Decide" [ref=e35]
    - link "Decide" [ref=e36]
    - button "All 13 batches" [expanded=false, ref=e18]
  - combobox "about:" [expanded=false, ref=e19]: desk · Inbox
    - option "Foreman" [ref=e37]
    - option "desk · Inbox" [selected, ref=e38]
    - option "desk · Contacts" [ref=e39]
    - option "t2-layout" [ref=e40]
  - button "Close chat" [ref=e20]
  - link "↗ run" [ref=e21]
  - link "↗ verdict, row 11" [ref=e22]
  - link "↗ decision card" [ref=e23]
  - button "Undo" [ref=e24]
  - textbox "Message Foreman..." [ref=e25]
  - button "Send" [disabled, ref=e26]
  - radio "next safe point" [checked=true, ref=e31]
  - radio "after batch" [checked=false, ref=e32]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
◂ Work
desk · Inbox at 100% Libredesk parity
active
Pause
Re-plan

Done when: all 120 checklist rows are DONE and verified by the judge

Progress
DONE 65
BUILT 3
TODO 52

Forecast about 9 more batches · $11 of API credit · 4 MiniMax windows · done around Tue (likely)

Spent $12.40 of the $40 share · first-pass yield 91% · $0.38 per DONE row

Strategy v2
re-planned 09:20 · after your scope answer
Compare v1
Fix batch first: rows 42, 76, 79, held from the earlier run
Contract batch: the 5 missing endpoints, before rows that use them
Layout, then components, then integration

Risk: realtime rows wait on your transport decision · 33 rows have no donor tests

Batches
✓
✓
✓
●
◌
○
◌
○
○
○
○
○
○
3
t1-status-filter
10 rows
✓
9 of 10 first pass
$0.88
Open
4
t2-layout
6 rows
●
worker · turn 14
$0.20
Watch
5
t3-bulk
20 rows
◌
waits on: Bulk actions in v1?
Decide
6
t4-list-items
6 rows
○
queued
7
t5-realtime
15 rows
◌
waits on: Realtime transport
Decide
All 13 batches
about:
Foreman
desk · Inbox
desk · Contacts
t2-layout

You · 11:50

Why did t1 need a second judge round?

Foreman · 11:50

Row 11 failed: its empty state used hard-coded English. The worker fixed it in round 2, and briefs now say "all UI copy comes from i18n".

↗ run
↗ verdict, row 11
↗ decision card

You · 11:54

Pause desk after this batch, resume at 9.

Foreman · 11:54

Done: pause after t2-layout, resume 09:00.

✓ 2 actions
Undo
Send
deliver
deliver
next safe point
after batch

```

## 18. Stop all asks first

Wireframes §3. URL `/foreman`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e21]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e22]
    - link "Decide" [ref=e28]
    - link "Decide" [ref=e29]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e23]
    - link "Details" [ref=e24]
    - button "Looks right" [ref=e30]
    - button "Looks right" [ref=e31]
    - button "Looks right" [ref=e32]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e25]
    - link "desk · Inbox" [ref=e33]
    - link "desk · Contacts" [ref=e34]
    - link "desk · Conversation" [ref=e35]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e26]
    - link "Watch" [ref=e36]
    - link "Watch" [ref=e37]
    - link "Watch" [ref=e38]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e27]
- heading "Stop all work?" [level=2, ref=e18]
- button "Cancel" [ref=e19]
- button "Stop all" [ref=e20]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:32 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:20 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:12 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0
Stop all work?

Workers stop at the next safe point and nothing new starts until you resume. Their sessions are kept.

Cancel
Stop all

```

## 19. Empty: no goals yet (Today)

Wireframes §15. URL `/foreman?scenario=empty`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12% Pause all Stop all Chat ⌘JTodayDecideWorkSettingsS" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - button "New goal" [ref=e12]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
Pause all
Stop all
Chat
⌘J
Today
Decide
Work
Settings
Studio ↗
Today

Give Foreman a goal

For example: take desk Contacts to 100% parity.

New goal

```

## 20. Empty: no goals yet (Work)

Wireframes §15. URL `/foreman/work?scenario=empty`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12% Pause all Stop all Chat ⌘JTodayDecideWorkSettingsS" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Work" [level=1, ref=e11]
  - radio "Board" [checked=true, ref=e14]
  - radio "List" [checked=false, ref=e15]
  - button "+ New goal" [ref=e12]
  - button "New goal" [ref=e13]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
Pause all
Stop all
Chat
⌘J
Today
Decide
Work
Settings
Studio ↗
Work

Programme: desk parity, 47 screens

View
View
Board
List
+ New goal

Give Foreman a goal

For example: take desk Contacts to 100% parity.

New goal

```

## 21. Nothing needs you

Wireframes §15. URL `/foreman/decide?scenario=quiet`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecideWork" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you" [ref=e13]
    - link "Review" [ref=e14]
    - link "History" [ref=e15]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
Work
Settings
Studio ↗
Decide
Needs you
Review
History

Nothing needs you.

Foreman is working on t2-layout.

```

## 22. Paused by the budget ceiling

Wireframes §15. URL `/foreman?scenario=budget-paused`.

`agent-browser snapshot -i -c`

```text
- generic "◌Paused · API ceiling reached · resumes Dec 1, or raise it (owner only)API $200 of $200MiniMax 5h 34" [ref=e1] clickable [onclick]
  - button "Pause all" [disabled, ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e18]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e19]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e20]
    - link "Details" [ref=e21]
    - button "Looks right" [ref=e27]
    - button "Looks right" [ref=e28]
    - button "Looks right" [ref=e29]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e22]
    - link "desk · Inbox" [ref=e30]
    - link "desk · Contacts" [ref=e31]
    - link "desk · Conversation" [ref=e32]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e23]
    - link "Watch" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Watch" [ref=e35]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e24]
```

`agent-browser get text body`

```text
◌
Paused · API ceiling reached · resumes Dec 1, or raise it (owner only)
API $200 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:32 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:20 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:12 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0

```

## 23. Workers paused by the MiniMax window

Wireframes §15. URL `/foreman?scenario=minimax-paused`.

`agent-browser snapshot -i -c`

```text
- generic "◌Workers paused · MiniMax 5h window at 80% · resumes 14:20. Foreman keeps planning.API $41.20 of $20" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e18]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e19]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e20]
    - link "Details" [ref=e21]
    - button "Looks right" [ref=e27]
    - button "Looks right" [ref=e28]
    - button "Looks right" [ref=e29]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e22]
    - link "desk · Inbox" [ref=e30]
    - link "desk · Contacts" [ref=e31]
    - link "desk · Conversation" [ref=e32]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e23]
    - link "Watch" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Watch" [ref=e35]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e24]
```

`agent-browser get text body`

```text
◌
Workers paused · MiniMax 5h window at 80% · resumes 14:20. Foreman keeps planning.
API $41.20 of $200
MiniMax 5h 80% · wk 31%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:32 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:20 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:12 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0

```

## 24. Degraded modes (BR-10.10), all six

Wireframes §15, BR-10.10. URL `/foreman?scenario=degraded`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JAPI credit unav" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e18]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e19]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e20]
    - link "Details" [ref=e21]
    - button "Looks right" [ref=e27]
    - button "Looks right" [ref=e28]
    - button "Looks right" [ref=e29]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e22]
    - link "desk · Inbox" [ref=e30]
    - link "desk · Contacts" [ref=e31]
    - link "desk · Conversation" [ref=e32]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e23]
    - link "Watch" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Watch" [ref=e35]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e24]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
API credit unavailable
Routine supervision continues in plain code. Running batches finish to a safe point, no new batches start, and decisions that need Opus queue up.
since 11:20
MiniMax unavailable
Workers pause at a safe point. Foreman keeps planning and learning.
since 10:20
cloudcli unavailable
Nothing new starts. Events are caught up when cloudcli returns, and no state is guessed.
since 09:20
Database unavailable
Foreman stops acting. Workers keep their sessions, nothing is lost, and Foreman resumes when the database is back.
since 08:20
infigraph unavailable
Briefs fall back to file paths from git, and each lower-quality brief is flagged.
since 07:20
Owner away
Work continues on everything not waiting on you. Waiting items collect into one digest, and after 24 hours with nothing unblocked Foreman idles and says so.
since 06:20
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:32 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:20 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:12 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0

```

## 25. A run failed

Wireframes §15. URL `/foreman/work/runs/run-t2?scenario=run-failed`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "t2-layout" [level=1, ref=e11]
  - region "Run" [ref=e12]
    - heading "Run" [level=2, ref=e19]
    - link "◂ desk · Inbox" [ref=e20]
    - combobox "Replay from step..." [expanded=false, ref=e16]
      - option "Replay from step..." [selected, ref=e24]
      - option "Brief" [ref=e25]
      - option "Worker" [ref=e26]
      - option "Checks" [ref=e27]
      - option "Judge" [ref=e28]
      - option "Close" [ref=e29]
    - button "Replay" [disabled, ref=e17]
  - region "Foreman decisions" [ref=e13]
    - heading "Foreman decisions" [level=2, ref=e21]
    - link "Card" [ref=e30]
  - region "Worker" [ref=e14]
    - heading "Worker" [level=2, ref=e22]
    - link "Open session ↗" [ref=e18]
  - region "Checks and verdict · after the worker finishes" [ref=e15]
    - heading "Checks and verdict · after the worker finishes" [level=2, ref=e23]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
t2-layout
Run
MiniMax-M3 · sandboxed · turn 14 · 23m · MiniMax 3% of the 5h window

◂ desk · Inbox / t2-layout

Brief
✓
──▸
Worker
✗
──▸
Checks
○
──▸
Judge
○
──▸
Close
○

Next Opus check: when the worker says done, asks something, or goes 10 turns without a commit

Failed at Worker: The worker stopped after a model refusal on turn 14 and made no commit. Foreman chose to retry.

Replay from step...
Brief
Worker
Checks
Judge
Close
Replay
Foreman decisions
turn 1
continue
rules
turn 5
continue
rules
turn 9
steer
Opus · $0.04
Card

"Reuse useConversationList; don't add a second fetch."

turn 14
continue
rules
Worker
now
editing InboxLayout.tsx
changed
4 files · +212 −31
tools
Read, Edit, Bash(pnpm test)
says
rows 4 and 7 built (informational only)
Open session ↗
Checks and verdict · after the worker finishes

The checks and the judge run after the worker finishes.

```

## 26. Taken over: You're driving

Wireframes §15. URL `/foreman/work/runs/run-t2?scenario=taken-over`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "t2-layout" [level=1, ref=e11]
  - region "Run" [ref=e12]
    - heading "Run" [level=2, ref=e21]
    - link "◂ desk · Inbox" [ref=e22]
    - button "Hand back to Foreman" [ref=e23]
    - button "Pause" [ref=e16]
    - button "Stop" [ref=e17]
    - combobox "Replay from step..." [expanded=false, ref=e18]
      - option "Replay from step..." [selected, ref=e27]
      - option "Brief" [ref=e28]
      - option "Worker" [ref=e29]
      - option "Checks" [ref=e30]
      - option "Judge" [ref=e31]
      - option "Close" [ref=e32]
    - button "Replay" [disabled, ref=e19]
  - region "Foreman decisions" [ref=e13]
    - heading "Foreman decisions" [level=2, ref=e24]
    - link "Card" [ref=e33]
  - region "Worker" [ref=e14]
    - heading "Worker" [level=2, ref=e25]
    - link "Open session ↗" [ref=e20]
  - region "Checks and verdict · after the worker finishes" [ref=e15]
    - heading "Checks and verdict · after the worker finishes" [level=2, ref=e26]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
t2-layout
Run
MiniMax-M3 · sandboxed · turn 14 · 23m · MiniMax 3% of the 5h window

◂ desk · Inbox / t2-layout

Brief
✓
──▸
Worker
●
──▸
Checks
○
──▸
Judge
○
──▸
Close
○

Next Opus check: when the worker says done, asks something, or goes 10 turns without a commit

You're driving. Foreman paused supervision of t2-layout and will resume when you hand back.
Hand back to Foreman
Pause
Stop
Replay from step...
Brief
Worker
Checks
Judge
Close
Replay
Foreman decisions
turn 1
continue
rules
turn 5
continue
rules
turn 9
steer
Opus · $0.04
Card

"Reuse useConversationList; don't add a second fetch."

turn 14
continue
rules
Worker
now
editing InboxLayout.tsx
changed
4 files · +212 −31
tools
Read, Edit, Bash(pnpm test)
says
rows 4 and 7 built (informational only)
Open session ↗
Checks and verdict · after the worker finishes

The checks and the judge run after the worker finishes.

```

## 27. Error on a screen, shell intact

Wireframes §15. URL `/foreman/decide/review?scenario=error`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JTodayDecide2Wor" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Decide" [level=1, ref=e11]
  - navigation "Decide sections" [ref=e12]
    - link "Needs you (2)" [ref=e13]
    - link "Review" [ref=e14]
    - link "History" [ref=e15]
  - button "Retry" [ref=e16]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
Today
Decide
2
Work
Settings
Studio ↗
Decide
Needs you (2)
Review
History

Foreman decided these alone. Each one stays open to veto until its window closes.

Could not load this.

Retry

OK closes an item early. Veto undoes the change and records why, so Foreman learns from it.

```

## 28. Foreman unreachable: banner on every screen

Wireframes §15. URL `/foreman/work?scenario=unreachable`.

`agent-browser snapshot -i -c`

```text
- generic "Foreman status unknown Pause all Stop all Chat ⌘JForeman isn't responding. Workers keep their sessio" [ref=e1] clickable [onclick]
  - button "Pause all" [disabled, ref=e3]
  - button "Stop all" [disabled, ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - button "Retry" [ref=e6]
  - button "Service log" [ref=e7]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e8]
    - link "Decide" [ref=e9]
    - link "Work" [ref=e10]
    - link "Settings" [ref=e11]
  - heading "Work" [level=1, ref=e12]
  - radio "Board" [checked=true, ref=e14]
  - radio "List" [checked=false, ref=e15]
  - button "+ New goal" [ref=e13]
  - button "Retry" [ref=e16]
```

`agent-browser get text body`

```text
Foreman status unknown
Pause all
Stop all
Chat
⌘J
Foreman isn't responding. Workers keep their sessions; nothing is lost.
Retry
Service log
Today
Decide
Work
Settings
Work

Work

View
View
Board
List
+ New goal

Could not load this.

Retry

```

## 29. Foreman unreachable: service log

Wireframes §15. URL `/foreman/work?scenario=unreachable`.

`agent-browser snapshot -i -c`

```text
- generic "Foreman status unknown Pause all Stop all Chat ⌘JForeman isn't responding. Workers keep their sessio" [ref=e1] clickable [onclick]
  - button "Pause all" [disabled, ref=e3]
  - button "Stop all" [disabled, ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - button "Retry" [ref=e6]
  - button "Service log" [ref=e7]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e8]
    - link "Decide" [ref=e9]
    - link "Work" [ref=e10]
    - link "Settings" [ref=e11]
  - heading "Work" [level=1, ref=e12]
  - radio "Board" [checked=true, ref=e16]
  - radio "List" [checked=false, ref=e17]
  - button "+ New goal" [ref=e13]
  - button "Retry" [ref=e18]
- heading "Foreman service log" [level=2, ref=e14]
- button "Close" [ref=e15]
```

`agent-browser get text body`

```text
Foreman status unknown
Pause all
Stop all
Chat
⌘J
Foreman isn't responding. Workers keep their sessions; nothing is lost.
Retry
Service log
Today
Decide
Work
Settings
Work

Work

View
View
Board
List
+ New goal

Could not load this.

Retry
Foreman service log
2026-11-11T06:20:34.345Z foreman.service started, pid 2214
2026-11-14T00:20:34.345Z scheduler: tick, 1 goal active
2026-11-14T04:20:34.345Z inbox: 2 owner questions pending
2026-11-14T06:00:34.345Z run t2-layout: turn 14 recorded, decision continue (code)
Close

```

## 30. Loading

Wireframes §15. URL `/foreman/decide/review?scenario=loading`.

`agent-browser snapshot -i -c`

```text
- generic "Connecting to Foreman... Pause all Stop all Chat ⌘JTodayDecideWorkSettingsDecideNeeds youReviewHisto" [ref=e1] clickable [onclick]
  - button "Pause all" [disabled, ref=e3]
  - button "Stop all" [disabled, ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
  - heading "Decide" [level=1, ref=e10]
  - navigation "Decide sections" [ref=e11]
    - link "Needs you" [ref=e12]
    - link "Review" [ref=e13]
    - link "History" [ref=e14]
```

`agent-browser get text body`

```text
Connecting to Foreman...
Pause all
Stop all
Chat
⌘J
Today
Decide
Work
Settings
Decide
Needs you
Review
History

Foreman decided these alone. Each one stays open to veto until its window closes.

Loading...

OK closes an item early. Veto undoes the change and records why, so Foreman learns from it.

```

## 31. Offline

Wireframes §15. URL `/foreman`.

`agent-browser snapshot -i -c`

```text
- generic "●RunningAPI $41.20 of $200MiniMax 5h 34% · wk 12%! 1 alert Pause all Stop all Chat ⌘JYou are offline" [ref=e1] clickable [onclick]
  - button "Pause all" [ref=e3]
  - button "Stop all" [ref=e4]
  - button "Chat ⌘J" [expanded=false, ref=e5]
  - navigation "Foreman" [ref=e2]
    - link "Today" [ref=e6]
    - link "Decide 2 decisions need you" [ref=e7]
    - link "Work" [ref=e8]
    - link "Settings" [ref=e9]
    - link "Studio ↗" [ref=e10]
  - heading "Today" [level=1, ref=e11]
  - region "Good afternoon" [ref=e12]
    - heading "Good afternoon" [level=2, ref=e18]
  - region "Needs you · blocking" [ref=e13]
    - heading "Needs you · blocking" [level=2, ref=e19]
    - link "Decide" [ref=e25]
    - link "Decide" [ref=e26]
  - region "Review · decided by Foreman, you can veto" [ref=e14]
    - heading "Review · decided by Foreman, you can veto" [level=2, ref=e20]
    - link "Details" [ref=e21]
    - button "Looks right" [ref=e27]
    - button "Looks right" [ref=e28]
    - button "Looks right" [ref=e29]
  - region "Goals" [ref=e15]
    - heading "Goals" [level=2, ref=e22]
    - link "desk · Inbox" [ref=e30]
    - link "desk · Contacts" [ref=e31]
    - link "desk · Conversation" [ref=e32]
  - region "Running now" [ref=e16]
    - heading "Running now" [level=2, ref=e23]
    - link "Watch" [ref=e33]
    - link "Watch" [ref=e34]
    - link "Watch" [ref=e35]
  - region "This week" [ref=e17]
    - heading "This week" [level=2, ref=e24]
```

`agent-browser get text body`

```text
●
Running
API $41.20 of $200
MiniMax 5h 34% · wk 12%
! 1 alert
Pause all
Stop all
Chat
⌘J
You are offline. What you see may be out of date, and nothing you do will reach Foreman until you are back online.
Today
Decide
2
Work
Settings
Studio ↗
Today
Good afternoon

Since you left at 22:10, Foreman finished 3 batches: 19 rows DONE, 17 of them on the first pass.

It learned 1 lesson and adopted 1 worker-setup change (+11 points first-pass yield, still being watched).

2 decisions need you. Together they hold 35 rows; everything else is moving.

Inbox is on track: about 9 more batches, $11 of API credit, done around Thursday.

Needs you · blocking

●Bulk actions in v1?

holds 20 rows · 2h

Decide

●Realtime transport

holds 15 rows · 2h

Decide
Review · decided by Foreman, you can veto
Details

Adopted rule hooks/state-reset in desk

Looks right

closes 15:32 · in 3h 11m

New lesson: all UI copy comes from i18n

Looks right

closes 19:20 · in 6h 59m

Re-planned desk · Inbox (strategy v2)

Looks right

closes 13:12 · in 51m

Goals
desk · Inbox
65/120
● on track · ~Tue · $11 to go
2 wait on you
desk · Contacts
0/96
○ queued after Inbox
desk · Conversation
0/140
○ queued after Contacts
Running now
t2-layout worker · turn 14 · 23m

! 9 turns without a commit

Watch
j3-judge grading 6 rows · 2m
Watch
desk boss handed over worker · turn 31 · 52m
Watch
This week
First-pass yield
84% → 91% ▲
Foreman $ per row
$0.46 → $0.38 ▼
You agreed
11 of 12 calls
False stops
0

```

## 32. Session view: Hand to Foreman on one of the owner's own sessions

Wireframes BR-2.10. URL `/session/sess-free`.

`agent-browser snapshot -i -c`

```text
- generic "CloudCLIProjectsConversationsCtrlKCloudCLIProjectsConversationsRunningdesk3 - /tmp/deskNew Sessionde" [ref=e1] clickable [onclick]
  - heading "CloudCLI" [level=1, ref=e2]
  - button "Refresh projects and sessions (Ctrl+R)" [ref=e3]
  - button "Create new project" [ref=e4]
  - button "Layout: Single" [expanded=false, ref=e5]
  - button "Select sessions" [ref=e6]
  - button "Which sessions to show" [expanded=false, ref=e7]
  - button "Hide sidebar" [ref=e8]
  - button "Projects" [ref=e9]
  - button "Conversations" [ref=e10]
  - button "Running sessions" [ref=e13]
  - button "Archive only" [ref=e14]
  - textbox "Search projects..." [ref=e15]
  - button "desk 3 - /tmp/desk" [ref=e16]
    - generic [ref=e20] clickable [cursor:pointer, onclick]
    - generic [ref=e21] clickable [cursor:pointer, onclick]
    - generic [ref=e22] clickable [cursor:pointer, onclick]
  - button "New Session" [ref=e17]
  - link "Claude desk boss: tidy the Contacts import 10m 3" [ref=e36]
  - button "Session options for desk boss: tidy the Contacts import" [expanded=false, ref=e61]
  - link "Claude desk boss 10m 3" [ref=e37]
  - button "Session options for desk boss" [expanded=false, ref=e62]
  - link "Claude t2-layout worker 10m 3" [ref=e38]
  - button "Session options for t2-layout worker" [expanded=false, ref=e63]
  - button "Settings" [ref=e11]
  - heading "desk boss: tidy the Contacts import" [level=2, ref=e23]
  - generic "Idle" [ref=e24] clickable [onclick]
  - button "Workspace views" [expanded=false, ref=e25]
  - button "Hand to Foreman" [ref=e18]
  - button "Choose Files" [ref=e43]: No file chosen
  - textbox "Type / for commands, @ for files, or ask Claude anything..." [ref=e64]
  - button "Attach files" [ref=e65]
  - button "Show token usage" [ref=e44]
  - button [ref=e66]
  - button "Quick commands" [expanded=false, ref=e45]
  - button "Schedule this message" [expanded=false, disabled, ref=e46]
  - button "Select model and reasoning effort" [expanded=false, ref=e47]
  - button "How should Claude actions be approved?" [expanded=false, ref=e48]
  - button "Send" [disabled, ref=e49]
  - button "Open settings panel" [ref=e12]
  - heading "Quick Settings" [level=3, ref=e19]
  - heading "APPEARANCE" [level=4, ref=e26]
  - switch "Toggle dark mode" [checked=false, ref=e27]
  - combobox [expanded=false, ref=e28]: English
    - option "English" [selected, ref=e50]
    - option "Français" [ref=e51]
    - option "Español" [ref=e52]
    - option "한국어" [ref=e53]
    - option "简体中文" [ref=e54]
    - option "繁體中文" [ref=e55]
    - option "日本語" [ref=e56]
    - option "Русский" [ref=e57]
    - option "Deutsch" [ref=e58]
    - option "Türkçe" [ref=e59]
    - option "Italiano" [ref=e60]
  - heading "TOOL DISPLAY" [level=4, ref=e29]
  - LabelText "Show raw parameters" [ref=e30] clickable [cursor:pointer]
    - checkbox "Show raw parameters" [checked=false, ref=e39]
  - LabelText "Show thinking" [ref=e31] clickable [cursor:pointer]
    - checkbox "Show thinking" [checked=true, ref=e40]
  - heading "INPUT SETTINGS" [level=4, ref=e32]
  - LabelText "Send by Ctrl+Enter" [ref=e33] clickable [cursor:pointer]
    - checkbox "Send by Ctrl+Enter" [checked=false, ref=e41]
  - heading "FOREMAN" [level=4, ref=e34]
  - LabelText "Show Foreman suggestions" [ref=e35] clickable [cursor:pointer]
    - checkbox "Show Foreman suggestions" [checked=true, ref=e42]
```

`agent-browser get text body`

```text
CloudCLI
Projects
Conversations
Ctrl
K
desk
3 - /tmp/desk
New Session
desk boss: tidy the Contacts import
10m
3
desk boss
10m
3
t2-layout worker
10m
3
Settings
desk boss: tidy the Contacts import
desk
Idle
Hand to Foreman

Continue your conversation

Ask questions about your code, request changes, or get help with development tasks

0
tokens
Default
Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands
Quick Settings
APPEARANCE
Dark Mode
Toggle dark mode
Language
English
Français
Español
한국어
简体中文
繁體中文
日本語
Русский
Deutsch
Türkçe
Italiano
TOOL DISPLAY
Show raw parameters
Show thinking
INPUT SETTINGS
Send by Ctrl+Enter

When enabled, pressing Ctrl+Enter will send the message instead of just Enter. This is useful for IME users to avoid accidental sends.

FOREMAN
Show Foreman suggestions

Foreman reads each finished turn and suggests the next step above the message box. Turn this off to hide the suggestions.

```

## 33. Hand to Foreman dialog (optional goal)

Wireframes BR-2.10. URL `/session/sess-free`.

`agent-browser snapshot -i -c`

```text
- generic "CloudCLIProjectsConversationsCtrlKCloudCLIProjectsConversationsRunningdesk3 - /tmp/deskNew Sessionde" [ref=e1] clickable [onclick]
  - heading "CloudCLI" [level=1, ref=e2]
  - button "Refresh projects and sessions (Ctrl+R)" [ref=e3]
  - button "Create new project" [ref=e4]
  - button "Layout: Single" [expanded=false, ref=e5]
  - button "Select sessions" [ref=e6]
  - button "Which sessions to show" [expanded=false, ref=e7]
  - button "Hide sidebar" [ref=e8]
  - button "Projects" [ref=e9]
  - button "Conversations" [ref=e10]
  - button "Running sessions" [ref=e13]
  - button "Archive only" [ref=e14]
  - textbox "Search projects..." [ref=e15]
  - button "desk 3 - /tmp/desk" [ref=e16]
    - generic [ref=e24] clickable [cursor:pointer, onclick]
    - generic [ref=e25] clickable [cursor:pointer, onclick]
    - generic [ref=e26] clickable [cursor:pointer, onclick]
  - button "New Session" [ref=e17]
  - link "Claude desk boss: tidy the Contacts import 10m 3" [ref=e40]
  - button "Session options for desk boss: tidy the Contacts import" [expanded=false, ref=e65]
  - link "Claude desk boss 10m 3" [ref=e41]
  - button "Session options for desk boss" [expanded=false, ref=e66]
  - link "Claude t2-layout worker 10m 3" [ref=e42]
  - button "Session options for t2-layout worker" [expanded=false, ref=e67]
  - button "Settings" [ref=e11]
  - heading "desk boss: tidy the Contacts import" [level=2, ref=e27]
  - generic "Idle" [ref=e28] clickable [onclick]
  - button "Workspace views" [expanded=false, ref=e29]
  - button "Hand to Foreman" [ref=e18]
  - button "Choose Files" [ref=e47]: No file chosen
  - textbox "Type / for commands, @ for files, or ask Claude anything..." [ref=e68]
  - button "Attach files" [ref=e69]
  - button "Show token usage" [ref=e48]
  - button [ref=e70]
  - button "Quick commands" [expanded=false, ref=e49]
  - button "Schedule this message" [expanded=false, disabled, ref=e50]
  - button "Select model and reasoning effort" [expanded=false, ref=e51]
  - button "How should Claude actions be approved?" [expanded=false, ref=e52]
  - button "Send" [disabled, ref=e53]
  - button "Open settings panel" [ref=e12]
  - heading "Quick Settings" [level=3, ref=e19]
  - heading "APPEARANCE" [level=4, ref=e30]
  - switch "Toggle dark mode" [checked=false, ref=e31]
  - combobox [expanded=false, ref=e32]: English
    - option "English" [selected, ref=e54]
    - option "Français" [ref=e55]
    - option "Español" [ref=e56]
    - option "한국어" [ref=e57]
    - option "简体中文" [ref=e58]
    - option "繁體中文" [ref=e59]
    - option "日本語" [ref=e60]
    - option "Русский" [ref=e61]
    - option "Deutsch" [ref=e62]
    - option "Türkçe" [ref=e63]
    - option "Italiano" [ref=e64]
  - heading "TOOL DISPLAY" [level=4, ref=e33]
  - LabelText "Show raw parameters" [ref=e34] clickable [cursor:pointer]
    - checkbox "Show raw parameters" [checked=false, ref=e43]
  - LabelText "Show thinking" [ref=e35] clickable [cursor:pointer]
    - checkbox "Show thinking" [checked=true, ref=e44]
  - heading "INPUT SETTINGS" [level=4, ref=e36]
  - LabelText "Send by Ctrl+Enter" [ref=e37] clickable [cursor:pointer]
    - checkbox "Send by Ctrl+Enter" [checked=false, ref=e45]
  - heading "FOREMAN" [level=4, ref=e38]
  - LabelText "Show Foreman suggestions" [ref=e39] clickable [cursor:pointer]
    - checkbox "Show Foreman suggestions" [checked=true, ref=e46]
- heading "Hand this session to Foreman" [level=2, ref=e20]
- textbox "Goal (optional)" [ref=e21]
- button "Cancel" [ref=e22]
- button "Hand over" [ref=e23]
```

`agent-browser get text body`

```text
CloudCLI
Projects
Conversations
Ctrl
K
desk
3 - /tmp/desk
New Session
desk boss: tidy the Contacts import
10m
3
desk boss
10m
3
t2-layout worker
10m
3
Settings
desk boss: tidy the Contacts import
desk
Idle
Hand to Foreman

Continue your conversation

Ask questions about your code, request changes, or get help with development tasks

0
tokens
Default
Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands
Quick Settings
APPEARANCE
Dark Mode
Toggle dark mode
Language
English
Français
Español
한국어
简体中文
繁體中文
日本語
Русский
Deutsch
Türkçe
Italiano
TOOL DISPLAY
Show raw parameters
Show thinking
INPUT SETTINGS
Send by Ctrl+Enter

When enabled, pressing Ctrl+Enter will send the message instead of just Enter. This is useful for IME users to avoid accidental sends.

FOREMAN
Show Foreman suggestions

Foreman reads each finished turn and suggests the next step above the message box. Turn this off to hide the suggestions.

Hand this session to Foreman
Goal (optional)

Leave it empty and Foreman takes the session over as it is. It supervises the session turn by turn, checks the result, and you can take it back at any time.

Cancel
Hand over

```

## 34. After the hand-over: the supervision banner with Take back

Wireframes BR-2.10. URL `/session/sess-free`.

`agent-browser snapshot -i -c`

```text
- generic "CloudCLIProjectsConversationsCtrlKCloudCLIProjectsConversationsRunningdesk3 - /tmp/deskNew Sessionde" [ref=e1] clickable [onclick]
  - heading "CloudCLI" [level=1, ref=e2]
  - button "Refresh projects and sessions (Ctrl+R)" [ref=e3]
  - button "Create new project" [ref=e4]
  - button "Layout: Single" [expanded=false, ref=e5]
  - button "Select sessions" [ref=e6]
  - button "Which sessions to show" [expanded=false, ref=e7]
  - button "Hide sidebar" [ref=e8]
  - button "Projects" [ref=e9]
  - button "Conversations" [ref=e10]
  - button "Running sessions" [ref=e13]
  - button "Archive only" [ref=e14]
  - textbox "Search projects..." [ref=e15]
  - button "desk 3 - /tmp/desk" [ref=e16]
    - generic [ref=e19] clickable [cursor:pointer, onclick]
    - generic [ref=e20] clickable [cursor:pointer, onclick]
    - generic [ref=e21] clickable [cursor:pointer, onclick]
  - button "New Session" [ref=e17]
  - link "Claude desk boss: tidy the Contacts import 10m 3" [ref=e37]
  - button "Session options for desk boss: tidy the Contacts import" [expanded=false, ref=e62]
  - link "Claude desk boss 10m 3" [ref=e38]
  - button "Session options for desk boss" [expanded=false, ref=e63]
  - link "Claude t2-layout worker 10m 3" [ref=e39]
  - button "Session options for t2-layout worker" [expanded=false, ref=e64]
  - button "Settings" [ref=e11]
  - heading "desk boss: tidy the Contacts import" [level=2, ref=e22]
  - generic "Idle" [ref=e23] clickable [onclick]
  - button "Workspace views" [expanded=false, ref=e24]
  - link "Watch in Foreman ▸" [ref=e25]
  - button "Take back" [ref=e26]
  - button "Choose Files" [ref=e44]: No file chosen
  - textbox "Type / for commands, @ for files, or ask Claude anything..." [ref=e65]
  - button "Attach files" [ref=e66]
  - button "Show token usage" [ref=e45]
  - button [ref=e67]
  - button "Quick commands" [expanded=false, ref=e46]
  - button "Schedule this message" [expanded=false, disabled, ref=e47]
  - button "Select model and reasoning effort" [expanded=false, ref=e48]
  - button "How should Claude actions be approved?" [expanded=false, ref=e49]
  - button "Send" [disabled, ref=e50]
  - button "Open settings panel" [ref=e12]
  - heading "Quick Settings" [level=3, ref=e18]
  - heading "APPEARANCE" [level=4, ref=e27]
  - switch "Toggle dark mode" [checked=false, ref=e28]
  - combobox [expanded=false, ref=e29]: English
    - option "English" [selected, ref=e51]
    - option "Français" [ref=e52]
    - option "Español" [ref=e53]
    - option "한국어" [ref=e54]
    - option "简体中文" [ref=e55]
    - option "繁體中文" [ref=e56]
    - option "日本語" [ref=e57]
    - option "Русский" [ref=e58]
    - option "Deutsch" [ref=e59]
    - option "Türkçe" [ref=e60]
    - option "Italiano" [ref=e61]
  - heading "TOOL DISPLAY" [level=4, ref=e30]
  - LabelText "Show raw parameters" [ref=e31] clickable [cursor:pointer]
    - checkbox "Show raw parameters" [checked=false, ref=e40]
  - LabelText "Show thinking" [ref=e32] clickable [cursor:pointer]
    - checkbox "Show thinking" [checked=true, ref=e41]
  - heading "INPUT SETTINGS" [level=4, ref=e33]
  - LabelText "Send by Ctrl+Enter" [ref=e34] clickable [cursor:pointer]
    - checkbox "Send by Ctrl+Enter" [checked=false, ref=e42]
  - heading "FOREMAN" [level=4, ref=e35]
  - LabelText "Show Foreman suggestions" [ref=e36] clickable [cursor:pointer]
    - checkbox "Show Foreman suggestions" [checked=true, ref=e43]
```

`agent-browser get text body`

```text
CloudCLI
Projects
Conversations
Ctrl
K
desk
3 - /tmp/desk
New Session
desk boss: tidy the Contacts import
10m
3
desk boss
10m
3
t2-layout worker
10m
3
Settings
desk boss: tidy the Contacts import
desk
Idle
Foreman is supervising this session. Goal: finish the Contacts import.
Watch in Foreman ▸
Take back

Continue your conversation

Ask questions about your code, request changes, or get help with development tasks

0
tokens
Default
Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands
Quick Settings
APPEARANCE
Dark Mode
Toggle dark mode
Language
English
Français
Español
한국어
简体中文
繁體中文
日本語
Русский
Deutsch
Türkçe
Italiano
TOOL DISPLAY
Show raw parameters
Show thinking
INPUT SETTINGS
Send by Ctrl+Enter

When enabled, pressing Ctrl+Enter will send the message instead of just Enter. This is useful for IME users to avoid accidental sends.

FOREMAN
Show Foreman suggestions

Foreman reads each finished turn and suggests the next step above the message box. Turn this off to hide the suggestions.

```

## 35. After Take back: the button returns

Wireframes BR-2.10. URL `/session/sess-desk-boss`.

`agent-browser snapshot -i -c`

```text
- generic "CloudCLIProjectsConversationsCtrlKCloudCLIProjectsConversationsRunningdesk3 - /tmp/deskNew Sessionde" [ref=e1] clickable [onclick]
  - heading "CloudCLI" [level=1, ref=e2]
  - button "Refresh projects and sessions (Ctrl+R)" [ref=e3]
  - button "Create new project" [ref=e4]
  - button "Layout: Single" [expanded=false, ref=e5]
  - button "Select sessions" [ref=e6]
  - button "Which sessions to show" [expanded=false, ref=e7]
  - button "Hide sidebar" [ref=e8]
  - button "Projects" [ref=e9]
  - button "Conversations" [ref=e10]
  - button "Running sessions" [ref=e13]
  - button "Archive only" [ref=e14]
  - textbox "Search projects..." [ref=e15]
  - button "desk 3 - /tmp/desk" [ref=e16]
    - generic [ref=e20] clickable [cursor:pointer, onclick]
    - generic [ref=e21] clickable [cursor:pointer, onclick]
    - generic [ref=e22] clickable [cursor:pointer, onclick]
  - button "New Session" [ref=e17]
  - link "Claude desk boss: tidy the Contacts import 10m 3" [ref=e36]
  - button "Session options for desk boss: tidy the Contacts import" [expanded=false, ref=e61]
  - link "Claude desk boss 10m 3" [ref=e37]
  - button "Session options for desk boss" [expanded=false, ref=e62]
  - link "Claude t2-layout worker 10m 3" [ref=e38]
  - button "Session options for t2-layout worker" [expanded=false, ref=e63]
  - button "Settings" [ref=e11]
  - heading "desk boss" [level=2, ref=e23]
  - generic "Idle" [ref=e24] clickable [onclick]
  - button "Workspace views" [expanded=false, ref=e25]
  - button "Hand to Foreman" [ref=e18]
  - button "Choose Files" [ref=e43]: No file chosen
  - textbox "Type / for commands, @ for files, or ask Claude anything..." [ref=e64]
  - button "Attach files" [ref=e65]
  - button "Show token usage" [ref=e44]
  - button [ref=e66]
  - button "Quick commands" [expanded=false, ref=e45]
  - button "Schedule this message" [expanded=false, disabled, ref=e46]
  - button "Select model and reasoning effort" [expanded=false, ref=e47]
  - button "How should Claude actions be approved?" [expanded=false, ref=e48]
  - button "Send" [disabled, ref=e49]
  - button "Open settings panel" [ref=e12]
  - heading "Quick Settings" [level=3, ref=e19]
  - heading "APPEARANCE" [level=4, ref=e26]
  - switch "Toggle dark mode" [checked=false, ref=e27]
  - combobox [expanded=false, ref=e28]: English
    - option "English" [selected, ref=e50]
    - option "Français" [ref=e51]
    - option "Español" [ref=e52]
    - option "한국어" [ref=e53]
    - option "简体中文" [ref=e54]
    - option "繁體中文" [ref=e55]
    - option "日本語" [ref=e56]
    - option "Русский" [ref=e57]
    - option "Deutsch" [ref=e58]
    - option "Türkçe" [ref=e59]
    - option "Italiano" [ref=e60]
  - heading "TOOL DISPLAY" [level=4, ref=e29]
  - LabelText "Show raw parameters" [ref=e30] clickable [cursor:pointer]
    - checkbox "Show raw parameters" [checked=false, ref=e39]
  - LabelText "Show thinking" [ref=e31] clickable [cursor:pointer]
    - checkbox "Show thinking" [checked=true, ref=e40]
  - heading "INPUT SETTINGS" [level=4, ref=e32]
  - LabelText "Send by Ctrl+Enter" [ref=e33] clickable [cursor:pointer]
    - checkbox "Send by Ctrl+Enter" [checked=false, ref=e41]
  - heading "FOREMAN" [level=4, ref=e34]
  - LabelText "Show Foreman suggestions" [ref=e35] clickable [cursor:pointer]
    - checkbox "Show Foreman suggestions" [checked=true, ref=e42]
```

`agent-browser get text body`

```text
CloudCLI
Projects
Conversations
Ctrl
K
desk
3 - /tmp/desk
New Session
desk boss: tidy the Contacts import
10m
3
desk boss
10m
3
t2-layout worker
10m
3
Settings
desk boss
desk
Idle
Hand to Foreman

Continue your conversation

Ask questions about your code, request changes, or get help with development tasks

0
tokens
Default
Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands
Quick Settings
APPEARANCE
Dark Mode
Toggle dark mode
Language
English
Français
Español
한국어
简体中文
繁體中文
日本語
Русский
Deutsch
Türkçe
Italiano
TOOL DISPLAY
Show raw parameters
Show thinking
INPUT SETTINGS
Send by Ctrl+Enter

When enabled, pressing Ctrl+Enter will send the message instead of just Enter. This is useful for IME users to avoid accidental sends.

FOREMAN
Show Foreman suggestions

Foreman reads each finished turn and suggests the next step above the message box. Turn this off to hide the suggestions.

```

## 36. A Foreman worker session: no hand-over offered

Wireframes BR-2.10. URL `/session/sess-t2-layout`.

`agent-browser snapshot -i -c`

```text
- generic "CloudCLIProjectsConversationsCtrlKCloudCLIProjectsConversationsRunningdesk3 - /tmp/deskNew Sessionde" [ref=e1] clickable [onclick]
  - heading "CloudCLI" [level=1, ref=e2]
  - button "Refresh projects and sessions (Ctrl+R)" [ref=e3]
  - button "Create new project" [ref=e4]
  - button "Layout: Single" [expanded=false, ref=e5]
  - button "Select sessions" [ref=e6]
  - button "Which sessions to show" [expanded=false, ref=e7]
  - button "Hide sidebar" [ref=e8]
  - button "Projects" [ref=e9]
  - button "Conversations" [ref=e10]
  - button "Running sessions" [ref=e13]
  - button "Archive only" [ref=e14]
  - textbox "Search projects..." [ref=e15]
  - button "desk 3 - /tmp/desk" [ref=e16]
    - generic [ref=e19] clickable [cursor:pointer, onclick]
    - generic [ref=e20] clickable [cursor:pointer, onclick]
    - generic [ref=e21] clickable [cursor:pointer, onclick]
  - button "New Session" [ref=e17]
  - link "Claude desk boss: tidy the Contacts import 10m 3" [ref=e35]
  - button "Session options for desk boss: tidy the Contacts import" [expanded=false, ref=e60]
  - link "Claude desk boss 10m 3" [ref=e36]
  - button "Session options for desk boss" [expanded=false, ref=e61]
  - link "Claude t2-layout worker 10m 3" [ref=e37]
  - button "Session options for t2-layout worker" [expanded=false, ref=e62]
  - button "Settings" [ref=e11]
  - heading "t2-layout worker" [level=2, ref=e22]
  - generic "Idle" [ref=e23] clickable [onclick]
  - button "Workspace views" [expanded=false, ref=e24]
  - button "Choose Files" [ref=e42]: No file chosen
  - textbox "Type / for commands, @ for files, or ask Claude anything..." [ref=e63]
  - button "Attach files" [ref=e64]
  - button "Show token usage" [ref=e43]
  - button [ref=e65]
  - button "Quick commands" [expanded=false, ref=e44]
  - button "Schedule this message" [expanded=false, disabled, ref=e45]
  - button "Select model and reasoning effort" [expanded=false, ref=e46]
  - button "How should Claude actions be approved?" [expanded=false, ref=e47]
  - button "Send" [disabled, ref=e48]
  - button "Open settings panel" [ref=e12]
  - heading "Quick Settings" [level=3, ref=e18]
  - heading "APPEARANCE" [level=4, ref=e25]
  - switch "Toggle dark mode" [checked=false, ref=e26]
  - combobox [expanded=false, ref=e27]: English
    - option "English" [selected, ref=e49]
    - option "Français" [ref=e50]
    - option "Español" [ref=e51]
    - option "한국어" [ref=e52]
    - option "简体中文" [ref=e53]
    - option "繁體中文" [ref=e54]
    - option "日本語" [ref=e55]
    - option "Русский" [ref=e56]
    - option "Deutsch" [ref=e57]
    - option "Türkçe" [ref=e58]
    - option "Italiano" [ref=e59]
  - heading "TOOL DISPLAY" [level=4, ref=e28]
  - LabelText "Show raw parameters" [ref=e29] clickable [cursor:pointer]
    - checkbox "Show raw parameters" [checked=false, ref=e38]
  - LabelText "Show thinking" [ref=e30] clickable [cursor:pointer]
    - checkbox "Show thinking" [checked=true, ref=e39]
  - heading "INPUT SETTINGS" [level=4, ref=e31]
  - LabelText "Send by Ctrl+Enter" [ref=e32] clickable [cursor:pointer]
    - checkbox "Send by Ctrl+Enter" [checked=false, ref=e40]
  - heading "FOREMAN" [level=4, ref=e33]
  - LabelText "Show Foreman suggestions" [ref=e34] clickable [cursor:pointer]
    - checkbox "Show Foreman suggestions" [checked=true, ref=e41]
```

`agent-browser get text body`

```text
CloudCLI
Projects
Conversations
Ctrl
K
desk
3 - /tmp/desk
New Session
desk boss: tidy the Contacts import
10m
3
desk boss
10m
3
t2-layout worker
10m
3
Settings
t2-layout worker
desk
Idle

Continue your conversation

Ask questions about your code, request changes, or get help with development tasks

0
tokens
Default
Enter to send • Shift+Enter for new line • Tab to change modes • / for slash commands
Quick Settings
APPEARANCE
Dark Mode
Toggle dark mode
Language
English
Français
Español
한국어
简体中文
繁體中文
日本語
Русский
Deutsch
Türkçe
Italiano
TOOL DISPLAY
Show raw parameters
Show thinking
INPUT SETTINGS
Send by Ctrl+Enter

When enabled, pressing Ctrl+Enter will send the message instead of just Enter. This is useful for IME users to avoid accidental sends.

FOREMAN
Show Foreman suggestions

Foreman reads each finished turn and suggests the next step above the message box. Turn this off to hide the suggestions.

```


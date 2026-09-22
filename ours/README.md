# Ours

A budgeting app built for two people rather than one person plus a guest. One HTML file, no build step,
no account, no server. Open `index.html` in a browser.

- **Live app:** https://claude.ai/artifact/V9mMR5C8RKCHLwQnhvrikU

Most couples apps are single-person budgeting tools with a second login. They split everything 50/50,
show every transaction to both people, and treat money as arithmetic. The arguments couples actually have
are about fairness, privacy, desire, and feeling unheard. Each feature below targets one of those.

## Features

| Feature | What it does |
|---|---|
| **Fairness dial** | Four ways to split the shared pot: 50/50, by paycheck, *equal breathing room* (both of you end the month with the same free money), or a custom split. The four are shown side by side, so the cost of 50/50 to the lower earner is a number you can see, not a feeling. |
| **Invisible work** | Log cooking, cleaning, admin and caregiving hours, valued at what you'd pay someone to do them. They show up in each person's true share of the household, and can offset cash contributions on the dial, from 0% to 100%. |
| **Sealed bids** | A purchase over your threshold cools off for 48 hours. Then each of you privately rates how much you want it (1–10) and the most you'd pay, passing the phone between you. The bids are revealed together and the app gives a verdict. Each of you gets one golden ticket per quarter: a yes the other can't veto. |
| **Comfort lines** | A private limit on a category that stresses you out. When shared spending crosses it, your *partner* gets a gentle, blame-free heads-up, and the item goes on the money date agenda. Your partner never sees the number. |
| **No-questions money** | Each of you gets a personal allowance. Your partner sees the balance go down but never what it went on. |
| **Money date** | A guided 20-minute weekly check-in with an agenda generated from your data: a win, the numbers, the hard part, sealed bids, one dream, and an appreciation from each of you. The app tracks your streak and keeps the appreciations. |
| **Dreams on your anniversary clock** | Goals are dated by your relationship ("just before your 7th anniversary"), and the app tells you how much more per month it would take to hit an earlier anniversary. Progress is drawn as two braided strands, one per partner. |
| **Storm test** | Tells you how many months your emergency fund lasts if either paycheck stops, or both, on bare-bones spending. Most tools only model one income. |

Use **Viewing as** in the header to switch between partners on a shared device. Private transactions and
comfort lines change with it.

## Notes

- The app opens with an example household, Sam and Riley. Settings → *Start blank* clears it.
- Data stays in the browser's `localStorage`. Settings → *Copy backup* / *Restore* moves it between devices.
- Invisible-work rates are rough US replacement costs per hour and can be edited.

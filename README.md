# Fortune Merlion
 
A browser-based game and event system built for Unigon's three-week pop-up activation at Plaza Singapura. Players play a Singapore-themed Phaser game, scores are validated and stored server-side, and a live display screen shows the action on a big screen at the event.
 
Live at: https://merlion-game.com
 
## Features
 
- Phaser 3 game that runs in the browser with no build step
- Real-time updates between the game, server and display screen via Socket.io
- Leaderboard and score storage in SQLite
- Anti-cheat: server-side score cap (`MAX_SCORE = 2000`), validated against a spawn-rate simulation of perfect play
- Self-contained profanity filter built from the client's moderation document
- Post-contest mode: phone number collection switches off automatically after the contest end date
- Broadcast / display screen (`display.html`) for the venue
## Tech stack
 
| Layer | Technology |
|---|---|
| Game engine | [Phaser 3](https://phaser.io/) (loaded via CDN) |
| Frontend | Plain HTML/JS, single-file `index.html`, no build tools |
| Display screen | `display.html` |
| Backend | Node.js, Express, Socket.io |
| Database | `node:sqlite` (built into Node 22.5+) |
| Frontend hosting | Cloudflare Pages |
| Backend hosting | Railway (Hobby plan) |
| Domain / DNS | Cloudflare Registrar, CNAME to `fortunemerlion.pages.dev`, automatic SSL |
| Asset tooling | Python (Pillow) and `pngquant` for image compression |
 
## Brand colours
 
Sampled from the original artwork:
 
| Name | Hex |
|---|---|
| Empathy | `#FF829A` |
| Nobility | `#33A7B4` |
| Longevity | `#C6BA26` |
| Vitality | `#A360C1` |
| Stability | `#FF9400` |
| Serenity | `#49CCD4` |
 
## Getting started
 
### Prerequisites
 
- Node.js **22.5 or newer** (required for `node:sqlite`)
- Python 3 with Pillow, and `pngquant` (only if you are processing images)
### Run the backend
 
```bash
npm install
node server.js
```
 
### Run the frontend
 
The frontend is static. Open `index.html` directly, or serve the folder locally:
 
```bash
npx serve .
```
 
Point the client at your local backend URL if it is not using the production one.
 
## Deployment
 
- **Frontend:** push to the connected branch and Cloudflare Pages deploys it automatically.
- **Backend:** push to the connected branch and Railway deploys it.
If a fix doesn't seem to show up, check deployment first: uncommitted changes, wrong branch or Cloudflare cache. View the page source and look for a distinctive string from your change before assuming the code is wrong.
 
## Design decisions and gotchas
 
- **`node:sqlite` instead of `better-sqlite3`:** native-compiled npm packages failed to build on Railway.
- **Custom profanity filter:** the `bad-words` package crashed production, so it was replaced.
- **Idempotent migrations:** schema changes run at boot and are safe to run repeatedly (for example, relaxing the `NOT NULL` constraint on the phone column after the contest).
- **Separate domain:** Wix doesn't support reverse proxying, so the game lives on its own domain rather than a subdirectory of the main Unigon site.
## Project structure
 
```
index.html     # Game client (Phaser 3)
display.html   # Venue display / broadcast screen
server.js      # Express + Socket.io backend, SQLite storage
```
 
## Status
 
The event has ended and the project is in maintenance / handoff. Ownership of the repository transfers to Unigon on completion.
 
## Credits
 
Built by Cheryl for UnigonPlays. Assets designed by UnigonPlays Team in Vietnam.

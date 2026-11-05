# Who's In?

Free attendance pages for soccer teams. Anyone can make a page for their team, get a private link, and send it to their friends. Players type their name once, then tap any game they can't make.

No dependencies: plain Node (24+) with its built-in SQLite.

## How it works

- `/` is the home page, where someone sets up a team and its schedule.
- `/t/<guid>` is a team's page. The GUID in the URL decides which team's data loads.
- There are no accounts. Anyone with a team's link can see and edit that team, including its schedule.
- A lost link can't be recovered yet. Email recovery is built but hidden on the home page until Resend is set up.

## Run it locally

```bash
npm start
```

Then open http://localhost:3000. Local data is stored in `data/whos-in.db`.

## Deploy to Railway

```bash
brew install railway
railway login
railway init
railway up
railway volume add
railway domain
```

When `railway volume add` asks for a mount path, use `/data`. Without a volume, every redeploy wipes the database.

To confirm the volume is in use, run `railway logs` and look for `database at /data/whos-in.db`.

## Set up email

Forgot-link emails go through [Resend](https://resend.com), because Railway's Hobby plan blocks SMTP. Locally, the email prints in the server log instead.

Email recovery is hidden for now. To turn it on, follow the comment in `public/index.html`, then set these variables on the Railway service:

- `RESEND_API_KEY`: your Resend API key.
- `EMAIL_FROM`: a sender on a domain verified in Resend, like `Who's In? <hello@yourdomain.com>`. Resend's default test sender only delivers to your own Resend account's address.
- `SITE_URL` (only with a custom domain): the site's address, like `https://yourdomain.com`. Otherwise, the Railway domain is used.

## Good to know

- Names ignore capitalization and extra spaces, so "marco" and "Marco" are the same player on a team.
- Removing a date from a schedule hides its answers. Adding that date back brings them back.
- Set `DB_PATH` to store the database somewhere else.

## License

MIT

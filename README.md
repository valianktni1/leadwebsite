# Ivory Digital — Lead website demos

A self-hosted demo library for TrueNAS. Upload static websites in a password-protected studio and share each company’s own URL.

- Public address: `https://websites.ivorydigital.uk`
- Management dashboard: `https://websites.ivorydigital.uk/admin`
- Example demo: `https://websites.ivorydigital.uk/willow-and-stone/`
- TrueNAS application source: `/mnt/apps/leadwebsite`
- Persistent account/mail configuration: `/mnt/apps/leadwebsite/config`
- Persistent demo files: `/mnt/photographers_data/leadwebsitedemos`
- Dockge stack: `leadwebsites`, supplied in `leadwebsites.yaml`
- Published port: **30065**, forwarding to container port **3000**

The company URL without a trailing slash redirects to the slash version so relative images, scripts and styles work correctly. Demos are public to anyone who has or guesses their URL. The public homepage does not list companies; the collection and upload APIs require admin authentication. Search engines are asked not to index the app or demos.

## Deploy on TrueNAS using Dockge

1. The supplied Compose file builds directly from the public [valianktni1/leadwebsite](https://github.com/valianktni1/leadwebsite) repository. No local source checkout or source-folder mount inside Dockge is required. `/mnt/apps/leadwebsite` remains the location for persistent app configuration. Git build contexts are supported by the [Compose build specification](https://docs.docker.com/reference/compose-file/build/#context).
2. Create `/mnt/photographers_data/leadwebsitedemos` and `/mnt/apps/leadwebsite/config`. The config folder holds the admin password hash, SMTP settings and mail encryption key; it must stay outside the public demos dataset.
3. The container runs as UID/GID **1000:1000**. Grant that identity read, write and traverse access to both the demos dataset and config folder using your TrueNAS permissions/ACL settings. The application source only needs to be readable for the Docker build. Do not make the datasets world-writable.
4. In Dockge, create the stack **leadwebsites** and paste `leadwebsites.yaml` into its Compose editor. Remove the old `ADMIN_USER` / `ADMIN_PASSWORD` variables if upgrading. No admin credentials are set in Compose now.
5. Build and deploy. Docker downloads the source from GitHub and installs the pinned dependencies automatically. The TrueNAS Docker host needs access to GitHub, the container registry and the npm registry during the build. The optional Compose Bake performance notice can be ignored. If the repository becomes private, the build will need Git authentication or a locally accessible checkout instead.
6. Check `http://TRUENAS-LAN-IP:30065/healthz`, then configure the HTTPS reverse proxy below. Open `https://websites.ivorydigital.uk/admin` immediately and create your admin account before sharing the domain. The first person completing setup becomes the single admin; setup closes permanently once that account exists. There are no default credentials.
7. Choose your email and a password of 12–128 characters. You are signed in immediately. Existing accounts survive restarts and rebuilds. In HTTPS deployments session cookies require HTTPS; the raw LAN HTTP address is for the health check, not normal sign-in.

Compose CLI alternative on TrueNAS:

```sh
cd /mnt/apps
git clone https://github.com/valianktni1/leadwebsite.git leadwebsite
cd /mnt/apps/leadwebsite
docker compose -f leadwebsites.yaml up -d --build
```

If the source directory already exists, update that checkout instead of cloning over it. Do not replace or remove its ignored `config` folder.

## Nginx reverse proxy and DNS

Point DNS for `websites.ivorydigital.uk` at the address used by your existing reverse proxy. Create an Nginx Proxy Manager proxy host:

| Setting | Value |
| --- | --- |
| Domain | `websites.ivorydigital.uk` |
| Scheme | `http` |
| Forward hostname/IP | Your TrueNAS LAN IP |
| Forward port | `30065` |
| SSL | Valid certificate for `websites.ivorydigital.uk` |
| Force SSL | Enabled |

The hostname and forwarded port above are the upstream destination; there is no need to open 30065 directly to the internet. The proxy must preserve the path and forward ordinary cookie headers. Sign-in now uses an HttpOnly, SameSite=Strict session cookie. Websockets are not required. Add this in the proxy host’s Advanced configuration to allow uploads:

```nginx
client_max_body_size 75m;
proxy_read_timeout 120s;
```

For plain Nginx, adapt this location inside your existing HTTPS server block:

```nginx
server_name websites.ivorydigital.uk;
client_max_body_size 75m;

location / {
    proxy_pass http://TRUENAS-LAN-IP:30065;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
```

## SMTP settings and sending emails

Inside the dashboard, open **Email settings**. Enter your sender name/email, SMTP host, port, encryption, SMTP username and password. Select **STARTTLS** (normally port 587) or **SSL/TLS** (normally port 465). TLS and certificate checks are required; plaintext SMTP is not supported. Some providers require an app password rather than your normal mailbox password. These transport settings follow the [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

Save, then select **Send me a test email** to send to your admin account's email address. Saving does not contact the mail server or send an email. The test is a real delivery attempt, and a successful result means the mail server accepted it; check your inbox/spam folder for final delivery. The saved password never returns to the browser. Leave it blank to retain it; if you change the SMTP host or username, enter the password again.

Each demo has **Send by email**. Enter one recipient, review/edit the subject and message, and click **Send email**. The app includes that demo's public URL below the message. Nothing is sent automatically. Your SMTP provider's sending limits, sender verification and network access from TrueNAS still apply.

SMTP passwords use AES-256-GCM encryption with the key in `config/mail.key`. The admin password uses salted scrypt hashing. Back up the entire private config folder securely, including both `settings.json` and `mail.key`. Access to both files permits decrypting the SMTP password, so restrict filesystem permissions. Never commit this folder or put it in the public dataset. Session tokens live in memory, expire after 12 hours, and are invalidated on app restart. **Sign out** revokes the current session. Sign-in/setup requests are rate-limited.

## The two included website demos

The existing **Alder & Ash** kitchen and **Vale** plumbing demos, with all local images, styles and scripts, are bundled in `seed-demos`. On startup the app copies missing folders to the mounted demos dataset:

- `/mnt/photographers_data/leadwebsitedemos/alder-and-ash` serves `https://websites.ivorydigital.uk/alder-and-ash/`.
- `/mnt/photographers_data/leadwebsitedemos/vale-plumbing` serves `https://websites.ivorydigital.uk/vale-plumbing/`.

Existing folders are always left untouched, so local edits are preserved. Both appear in the dashboard after deployment. Their original enquiry forms remain browser-only demonstrations; outreach email delivery is managed from the studio. Removing a bundled demo from the dataset while leaving it in `seed-demos` makes it return on the next restart; remove its seed folder from the app source too if you no longer want it. Imagery attribution is in `DEMO-ASSETS.md`.

## Add and share demos

Open `/admin` and sign in with the email and password you chose during first-run setup. Select **Add a demo**, enter a company name, choose its URL slug, and select either an HTML file or an entire website folder. Folder upload preserves subfolders and removes the outer folder name. Choose files is suitable for a single HTML file or files all in the same directory. Publish, then use **View demo** or **Copy link**. Up to 1,000 files / 50 MB per upload. Existing slugs cannot be overwritten through the dashboard.

You can also copy a demo directly onto TrueNAS:

```text
/mnt/photographers_data/leadwebsitedemos/
  willow-and-stone/
    index.html
    about.html
    assets/
      style.css
      photo.webp
  another-company/
    index.html
```

This immediately serves `https://websites.ivorydigital.uk/willow-and-stone/` without restarting anything. Manually copied folders appear in the dashboard using their folder name; uploads also save the company name and date in a hidden `.demo.json` file. Do not place private files or secrets in a public demo directory. Hidden files and symlinks outside a demo's own folder are blocked.

Use relative links (`./assets/style.css`, `./about.html`), because `/assets/style.css` points to the host’s root rather than the company folder. Static HTML/CSS/JS websites are supported; PHP, WordPress and server-side applications need their own hosting. Uploaded demos receive a browser sandbox policy allowing scripts, forms, popups and downloads, while keeping them isolated from the admin dashboard. Features needing a same-origin context, such as localStorage, service workers and JavaScript module/CORS requests, may need adapting. Ordinary relative CSS, classic scripts and image links work. Demos never inherit the dashboard's authentication or get the Ivory Digital footer injected automatically: include the responsive footer and visible **Site designed by Ivory Digital** credit in every demo we build. A ready-to-use example is in `examples/sample-company/index.html`.

## Update, remove and back up

To update a demo, replace files in its dataset folder. To remove a demo, move its folder outside the served dataset or delete it after taking a backup. The dashboard discovers these changes automatically. Back up/snapshot the demos dataset and the private config folder; retain source and Dockge configuration separately. Keep credentials out of Git.

For app updates, replace the source files and rebuild/redeploy the `leadwebsites` stack. The mounted demos dataset survives container rebuilds. Use **Sign out** on shared computers. There is no self-service password reset in this version; retain a password-manager copy of your chosen admin credentials. If access is lost, a server administrator can move the private config folder to a secure backup outside the checkout and create a fresh account, but SMTP settings must then be entered again. Never delete the sole config backup.

## Local development and checks

Node.js 22 or newer and npm. In PowerShell:

```powershell
npm ci
$env:PUBLIC_URL = 'http://localhost:3000'
node server.mjs
```

Open `http://localhost:3000/admin`. Local demos are stored in `./data` (ignored by Git). `node --test` (or `npm test` when npm is installed) covers first-run setup, concurrent setup protection, login/logout, persistence, password hashing, encrypted SMTP settings, email transport behaviour, demo seeding, uploads, redirects, assets and file boundaries. SMTP tests use a fake mail transport; a real test email must be sent using your own settings after deployment. Docker/TrueNAS deployment must be validated on the destination host.

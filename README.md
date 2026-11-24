# Ivory Digital — Lead website demos

A self-hosted demo library for TrueNAS. Upload static websites in a password-protected studio and share each company’s own URL.

- Public address: `https://websites.ivorydigital.uk`
- Management dashboard: `https://websites.ivorydigital.uk/admin`
- Example demo: `https://websites.ivorydigital.uk/willow-and-stone/`
- TrueNAS application source: `/mnt/apps/leadwebsite`
- Persistent demo files: `/mnt/photographers_data/leadwebsitedemos`
- Dockge stack: `leadwebsites`, supplied in `leadwebsites.yaml`
- Published port: **30065**, forwarding to container port **3000**

The company URL without a trailing slash redirects to the slash version so relative images, scripts and styles work correctly. Demos are public to anyone who has or guesses their URL. The public homepage does not list companies; the collection and upload APIs require admin authentication. Search engines are asked not to index the app or demos.

## Deploy on TrueNAS using Dockge

1. Create `/mnt/apps/leadwebsite` and `/mnt/photographers_data/leadwebsitedemos`.
2. Copy `Dockerfile`, `package.json`, `server.mjs` and the entire `public` directory into `/mnt/apps/leadwebsite`. Alternatively, extract the supplied deployment ZIP there; the Dockerfile should be directly inside that directory.
3. The container runs as UID/GID **1000:1000**. Grant that identity read, write and traverse access to the demos dataset using your TrueNAS dataset permissions/ACL settings. The application source only needs to be readable for the Docker build. Do not make the dataset world-writable.
4. In Dockge, create a stack named **leadwebsites**. Paste the contents of `leadwebsites.yaml` into its Compose editor (Dockge normally saves this as `compose.yaml`). The included file is named `leadwebsites.yaml` as requested; the stack name is also explicitly set in the YAML.
5. In the stack's environment / `.env` editor, set:

   ```dotenv
   ADMIN_USER=admin
   ADMIN_PASSWORD=your-long-unique-password-at-least-16-characters
   ```

6. Build and deploy the stack. The absolute build context reads `/mnt/apps/leadwebsite` on the Docker host; that path must be accessible to Dockge. If Dockge is containerised, ensure `/mnt/apps/leadwebsite` is also mounted at the same path inside Dockge so it can send the build context.
7. Test `http://TRUENAS-LAN-IP:30065/healthz`; it should return `{"status":"ok"}`. Use the HTTPS address for normal dashboard access.

Compose CLI alternative on TrueNAS, after setting the environment file:

```sh
cd /mnt/apps/leadwebsite
docker compose --env-file .env -f leadwebsites.yaml up -d --build
```

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

The hostname and forwarded port above are the upstream destination; there is no need to open 30065 directly to the internet. The proxy must preserve the path and pass the `Authorization` header for dashboard sign-in. Websockets are not required. Add this in the proxy host’s Advanced configuration to allow uploads:

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

## Add and share demos

Open `/admin` and sign in with your configured credentials. Select **Add a demo**, enter a company name, choose its URL slug, and select either an HTML file or an entire website folder. Folder upload preserves subfolders and removes the outer folder name. Choose files is suitable for a single HTML file or files all in the same directory. Publish, then use **View demo** or **Copy link**. Up to 1,000 files / 50 MB per upload. Existing slugs cannot be overwritten through the dashboard.

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

To update a demo, replace files in its dataset folder. To remove a demo, move its folder outside the served dataset or delete it after taking a backup. The dashboard discovers these changes automatically. Back up/snapshot the demos dataset; retain source and the Dockge configuration separately. Keep the admin password out of Git.

For app updates, replace the source files and rebuild/redeploy the `leadwebsites` stack. The mounted demos dataset survives container rebuilds. Browser Basic Auth keeps you signed in until the browser session is cleared; use a private browser window for shared computers. Changing `ADMIN_PASSWORD` and redeploying invalidates the old password.

## Local development and checks

Node.js 22 or newer; no npm dependencies are required. In PowerShell:

```powershell
$env:ADMIN_PASSWORD = 'a-long-local-testing-password'
$env:PUBLIC_URL = 'http://localhost:3000'
node server.mjs
```

Open `http://localhost:3000/admin`. Local demos are stored in `./data` (ignored by Git). `node --test` (or `npm test` when npm is installed) covers authentication, uploads, duplicate slugs, redirects, assets, traversal protection, request origins and direct filesystem discovery. Docker/TrueNAS deployment must be validated on the destination host.

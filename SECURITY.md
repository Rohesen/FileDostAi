# Security

How the server protects itself and its visitors, and what to set when it goes public.

## What is in place

| Threat | Protection | Where |
|---|---|---|
| A malicious or broken file crashes or freezes the server | Every server job runs in its own short-lived process with a time limit (300 s), a memory cap (3 GB) and a cap on jobs at once. A crash or a hang only ends that one job. | `sandbox.py` |
| Server swamped by big uploads or many requests | Upload cap (100 MB), per-visitor limit of 60 server jobs an hour, "busy, try again" instead of piling up work | `guards.py`, `sandbox.py` |
| Office file makes the server fetch internal URLs (SSRF) or run macros | LibreOffice runs with a locked-down profile: no macros, no formula recalculation on load, no fetching of linked images or files. Rewritten before every conversion. Tested by `test_office_file_cannot_make_server_fetch_urls`. | `converters.py` |
| Word/Excel/PowerPoint macros (Windows, Microsoft Office) | `AutomationSecurity = force disable`, no link updates | `office_com_worker.py` |
| "Zip bombs" and image bombs | Office files expanding past 600 MB and images over 60 megapixels are refused | `converters.py`, `pdf_engine.py` |
| Scripts in uploaded HTML/Markdown | Scripts, frames, forms, remote images and CSS URLs are stripped before rendering | `converters.py` |
| Ghostscript file access | Runs with `-dSAFER` and reads only its own temp folder | `converters.py` |
| Cross-site scripting, clickjacking, MIME sniffing | Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` on every response | `main.py` |
| Results cached by a proxy or CDN | `Cache-Control: no-store` on every `/api/` response | `main.py` |
| Error messages leaking paths or library internals | Unexpected errors are logged on the server and shown to the user as a plain message | `main.py` |
| Other websites using your server from their visitors' browsers | No CORS unless `ULTRAPDF_CORS_ORIGINS` lists them | `main.py` |
| Fake `X-Forwarded-For` to dodge the rate limit | Only the address your own proxy added is trusted; IPv6 counted per /64 | `guards.py` |
| Fake `Host` header in page links | Links use `site_url` from brand.json once it's set; `ULTRAPDF_ALLOWED_HOSTS` rejects other hosts | `main.py` |
| Planted LibreOffice profiles in a shared temp folder | Profiles live in a private, owner-only folder | `converters.py` |
| Feedback file filling the disk or leaking emails | 20 MB cap, owner-only permissions, control characters removed | `feedback.py` |
| A break-out reaching the rest of the machine | Docker image runs as a normal user; `docker-compose.yml` adds a read-only filesystem, no Linux capabilities, memory and process limits | `Dockerfile`, `docker-compose.yml` |
| Files kept on the server | Files are processed in memory or in temp folders deleted right after each job; nothing is stored | all |

## Settings for a public server

Set these as environment variables (docker-compose.yml has them ready):

- `ULTRAPDF_TRUST_PROXY=cloudflare` behind Cloudflare, `1` behind nginx/Caddy. Leave it unset when nothing is in front, or visitors could fake their address.
- `ULTRAPDF_HTTPS=1` once the site is on HTTPS (adds HSTS).
- `ULTRAPDF_ALLOWED_HOSTS=yourdomain.com,www.yourdomain.com`
- Set `site_url` in brand.json to the real address.
- Optional: `ULTRAPDF_MAX_UPLOAD_MB`, `ULTRAPDF_RATE_LIMIT`, `ULTRAPDF_MAX_JOBS`, `ULTRAPDF_JOB_TIMEOUT`, `ULTRAPDF_JOB_MEMORY_MB`.
- `ULTRAPDF_API_DOCS=1` only for local development (`run.sh` sets it).

On the cloud machine itself:

1. Firewall: allow ports 80/443 only from Cloudflare's IP ranges (https://www.cloudflare.com/ips/) and SSH only from your own IP. Nobody should reach port 8000 directly.
2. Block the container from the cloud metadata address so a converter can never read machine credentials:
   `sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP`
3. SSH with keys only (`PasswordAuthentication no`), and turn on automatic security updates (`unattended-upgrades` on Ubuntu).
4. Rebuild the image monthly (`docker compose build --pull && docker compose up -d`) to pick up fixes in LibreOffice, Ghostscript, Tesseract and the Python libraries.
5. In Cloudflare: SSL mode "Full (strict)", "Always Use HTTPS", Bot Fight Mode on, and a rate-limiting rule on `/api/` as a second layer.

## Reporting a problem

Email the contact address in brand.json. Please don't open a public issue for security problems.

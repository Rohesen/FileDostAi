# Hosting FileDost AI

Short answer: **it runs anywhere that can run a Docker container (or Python plus a few Linux programs) with about 2 GB of RAM or more.** It breaks on hosts that only serve static files or only run short "serverless" functions.

## Where it works

| Host | Works? | Notes |
|---|---|---|
| A Linux server (VPS) with Docker: **Oracle Cloud Always Free**, Hetzner, DigitalOcean, Vultr, AWS Lightsail, Google Compute Engine | ✅ Best choice | `docker compose up -d --build`. Every tool works, and this is the setup the security settings were written for. Works on both Intel/AMD and ARM (Oracle's free Ampere machines). |
| Container platforms: Render, Railway, Fly.io, Koyeb, Google Cloud Run, Azure Container Apps | ✅ With a paid plan | Point them at the `Dockerfile`. The app reads the port from `$PORT`, so nothing else is needed. Pick a plan with **2 GB of RAM or more**: free plans (about 512 MB) run out of memory on Word/Excel conversion and OCR. Cloud Run limits uploads to 32 MB per request. |
| Your own Windows PC | ✅ | What you use now. Word, Excel and PowerPoint conversions use Microsoft Office when it is installed. |

## Where it breaks

| Host | What happens |
|---|---|
| **Static-only hosts**: GitHub Pages, Netlify, Cloudflare Pages, Vercel (static), Firebase Hosting | The page loads and the tools that run in the browser work (organise, sign, images, QR, ZIP, video). Every tool that needs the server (compress PDF, Office conversions, OCR, PDF to Word, protect/unlock, redact…) fails, and links like `/merge-pdf` show 404 on refresh. |
| **Serverless functions**: Vercel/Netlify functions, AWS Lambda, Cloudflare Workers | No LibreOffice, Tesseract or Ghostscript; tiny upload limits (Vercel 4.5 MB); the job sandbox needs a long-running process. Not supported. |
| **Shared PHP hosting** (Hostinger shared, GoDaddy cPanel…) | No Python service, no Docker. Not supported. |
| **Free tiers with 512 MB of RAM** | Starts fine, then crashes on big Office files or OCR. Light PDF tools still work. |

## What the server needs

All of this is already in the `Dockerfile`:

- Python 3.11 or newer.
- LibreOffice, for Word, Excel and PowerPoint conversions. On Windows, Microsoft Office is used instead when it is installed.
- Tesseract with language packs, for OCR. The image includes English, German, French, Spanish and the 12 Indian languages the site offers.
- Ghostscript, for compression and PDF/A.
- About 2 GB of RAM for one or two people at a time, or 4 GB or more for a public site. Plus 2 GB of temporary disk for jobs.

## Settings

Set these as environment variables (`docker-compose.yml` has them ready):

| Variable | When to set it |
|---|---|
| `PORT` | Set automatically by Render, Railway, Fly.io, Cloud Run and similar hosts. The default is 8000. |
| `ULTRAPDF_TRUST_PROXY` | Behind Cloudflare use `cloudflare`. Behind a platform's load balancer, nginx or Caddy use `1`. **If you forget this on Render, Railway or Fly.io, every visitor shares one rate limit (60 jobs an hour for the whole site).** |
| `ULTRAPDF_HTTPS=1` | When the site is served over HTTPS (always, in production). |
| `ULTRAPDF_ALLOWED_HOSTS` | Your domain names, for example `example.com,www.example.com`. `127.0.0.1` and `localhost` are always allowed so the health check keeps working. |
| `ULTRAPDF_MAX_UPLOAD_MB` | The upload limit, 100 MB by default. Cloudflare's free plan also caps uploads at 100 MB. |
| `ULTRAPDF_RATE_LIMIT` | Server jobs per visitor per hour, 60 by default. |

## Good to know

- **Files are never stored.** Jobs run in temporary space and are deleted afterwards, so a host that wipes its disk on restart loses nothing important. Only feedback and ratings are kept, in `ULTRAPDF_DATA_DIR`, so give that folder a persistent volume if you want to keep them.
- **The video tools download a 31 MB engine** into the visitor's browser the first time they are used. It is a static file, so Cloudflare caches it.
- **The job sandbox** runs each server job in a separate process. It is on by default on Linux and macOS, and off on Windows.
- **Keep it updated:** rebuild every month (`docker compose build --pull && docker compose up -d`) to pick up security fixes. More in `SECURITY.md`.

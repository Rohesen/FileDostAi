# Launch FileDost AI for the public, step by step

Following this guide puts your app on the internet at your own address, with these properties:
- it is served over HTTPS (padlock)
- it costs ₹0 a month, apart from the domain at roughly ₹500 to ₹1,100 a year
- it is reachable by anyone

Plan about 2 to 3 hours the first time. Most of that is waiting for sign-ups, DNS and the first build.

**The setup in one picture**

```
Visitor's browser  ──HTTPS──▶  Cloudflare (free)  ──secure tunnel──▶  Your Oracle Cloud server (free)
                                                                       └ Docker: the app + the tunnel
```

The server never opens a website port to the internet. The **Cloudflare Tunnel** connects outward to Cloudflare, so you skip three jobs: HTTPS certificates, firewall rules for web traffic, and Oracle's port settings.

**Files in this folder**

| File | What it is |
|---|---|
| `server-setup.sh` | Run once on a new server. Installs Docker, automatic security updates and swap, and adds the safety rule from SECURITY.md. |
| `deploy.sh` | Starts the site the first time. Run it again to update after you change the code. |
| `backup.sh` | Saves the ratings and feedback, the only data the site keeps. |
| `docker-compose.override.yml` | Adds the Cloudflare Tunnel and the production settings to the app's `docker-compose.yml`. |
| `env.example` | Shows the two private settings (`DOMAIN`, `TUNNEL_TOKEN`). `deploy.sh` asks for them on the first run. |
| `gitignore.txt` | Rename it to `.gitignore` so private and junk files never go to GitHub. |
| `Caddyfile` | Only for Appendix B, the alternative setup without the tunnel. |

---

## What it costs

| Item | Cheapest choice | Cost |
|---|---|---|
| Server | Oracle Cloud Always Free (2 CPU, 12 GB RAM, Mumbai) | ₹0 |
| HTTPS, protection, CDN | Cloudflare Free plan and Cloudflare Tunnel | ₹0 |
| Code hosting | GitHub (public repository) | ₹0 |
| Uptime alerts, analytics | UptimeRobot free, Cloudflare Web Analytics | ₹0 |
| Domain | `.in` at about ₹500 to ₹800 a year, or `.com` at about ₹850 to ₹1,100 a year | **the only real cost** |

**Total: about ₹500 to ₹1,100 a year.** Always compare the **renewal** price, not just the first year.

**Where to buy the domain** (prices checked October 2026):

| Registrar | .com first year | .com renewal | Notes |
|---|---|---|---|
| **Cloudflare Registrar** (recommended) | about ₹900 ($10.46) | same | Cost price, no markup, free privacy. You buy it inside the Cloudflare dashboard, so Step 3's nameserver change is skipped. Card or PayPal only; no UPI. Doesn't sell `.in`. |
| Porkbun | about ₹950 ($11.08) | same | Free privacy. Card or PayPal. |
| Namecheap | ₹600–1,000 | about ₹1,600 | Renewal jumps. |
| GoDaddy / Hostinger / BigRock | ₹1 (with a 3-year term) | ₹750–1,600 | Take UPI, but watch the renewal price and the add-ons at checkout. |

If you want `.in` instead, or need to pay by UPI, use an Indian registrar such as Hostinger or GoDaddy India. Expect about ₹500–800 a year, and check the renewal price.

Things that save money:
- Skip cheap first-year domains like `.xyz` or `.online` (₹100 to ₹200). Renewals jump to ₹1,500 or more, and spam filters and visitors trust them less.
- Skip every add-on registrars offer (hosting, "SSL", email, privacy packs). Cloudflare covers HTTPS, and most registrars include WHOIS privacy free.
- For a free email like `hello@yourdomain`, use Cloudflare **Email Routing**. It forwards to your Gmail at no cost.

**Truly ₹0, for testing only**: you can skip the domain and use a free name such as `yourname.duckdns.org` with the Caddy setup in Appendix B. It works, but it looks less trustworthy and is harder to find on Google. Use it to try things out, then buy a real domain for the public launch.

## Step 0. Domain ✅ done

You bought **filedostai.com** on Cloudflare Registrar on 15 October 2026. Turn on **auto-renew** under Domains → Registrations → filedostai.com → Manage, so it never expires.

## Step 1. Put your name and details into the app

On your PC, open the app folder (`Downloads\ultra_pdf\ultra_pdf`).

1. **`brand.json`**: open it in Notepad. The name, logo and `site_url` (https://filedostai.com) are already set. Fill in the other two fields:
   ```json
   "contact_email": "you@gmail.com",
   "source_code_url": "https://github.com/YOUR-GITHUB-NAME/filedost"
   ```
   Use your real email and GitHub name. For a free `hello@filedostai.com` address, turn on Cloudflare **Email Routing** for the domain; it forwards to your Gmail.
2. **`static/support.js`**: replace each `REPLACE_ME`:
   - your UPI ID, for example `rohesen@okaxis`
   - your Buy Me a Coffee, GitHub Sponsors and PayPal names
   - the sponsor email

   Delete the line of any donation method you don't use. Buttons still showing `REPLACE_ME` say "not set up yet" instead of breaking.
3. Copy this `launch` folder into the app folder and rename the copy to **`deploy`**. You should then have `ultra_pdf\ultra_pdf\deploy\deploy.sh` and the other files.
4. Rename `deploy\gitignore.txt` to `.gitignore` and move it up one level, into the app folder itself, next to `README.md`.

## Step 2. Put the code on GitHub

Your app is open source under the AGPL licence. The licence says people who use the site must be able to get its source, so a public GitHub repository is both the rule and the easiest way to get the code onto the server.

1. Create a free account at https://github.com.
2. Install **GitHub Desktop** (https://desktop.github.com) and sign in.
3. Go to **File → Add local repository** and choose the app folder. When it says this is not a repository, click **create a repository** there.
   - Name: your app name, for example `filedost`.
   - Licence: **GNU Affero General Public License v3.0**.
4. Check the list of files on the left. You should see **no** `.env`, `__pycache__` or `.venv`.
5. Click **Commit to main**, then **Publish repository**. Untick "Keep this code private".

You don't need to learn Git commands. GitHub Desktop's "Commit" and "Push" buttons are enough for updates later.

## Step 3. Domain settings in Cloudflare

Because you bought the domain on Cloudflare, it is already connected: there are no nameservers to change and nothing to wait for. Just switch on two settings:

1. In the Cloudflare dashboard, click **filedostai.com** (under Account home or Domains).
2. **SSL/TLS → Edge Certificates → Always Use HTTPS**: On
3. **Security → Bots → Bot Fight Mode**: On

Don't add any DNS records by hand. The tunnel in Step 6 creates them for you.

## Step 4. Create the free server on Oracle Cloud

1. Sign up at https://www.oracle.com/cloud/free/.
   - A card is needed to verify you. Free resources are not charged.
   - **Home region: choose India West (Mumbai) or India South (Hyderabad).** You can't change it later.
2. In the console, go to **Compute → Instances → Create instance** and fill in:
   - **Name**: e.g. `filedost`
   - **Image**: click *Change image* and choose **Canonical Ubuntu 24.04** (not the "Minimal" one)
   - **Shape**: click *Change shape*, then **Ampere**, then **VM.Standard.A1.Flex**. Set **2 OCPUs** and **12 GB memory**. It shows "Always Free-eligible".
   - **SSH keys**: choose **Generate a key pair for me** and click **Download private key**. Save the file as `C:\Users\rohes\.ssh\filedost.key`. **Don't lose it. It is the only way into the server.**
   - **Boot volume**: tick *Specify a custom size* and enter **100 GB** (up to 200 GB is free).
3. Click **Create**. When the instance is *Running*, copy its **Public IP address**.

**If you see "Out of capacity for shape VM.Standard.A1.Flex"**, the free machines in your region are all taken right now. You can:
- try another *Availability domain* in the same form
- try again a few hours later
- upgrade the account to **Pay As You Go** (Billing → Upgrade). You still pay ₹0 inside the free limits, it usually fixes the capacity problem, and it stops Oracle from reclaiming idle free machines.

If Oracle still won't work, see **Appendix A** for the paid option: Hetzner, about ₹450 a month.

## Step 5. Log in to the server and set it up

1. On your PC, open **PowerShell** and connect. Replace `SERVER_IP` with the address from Step 4.
   ```powershell
   ssh -i $HOME\.ssh\filedost.key ubuntu@SERVER_IP
   ```
   Type `yes` the first time. If Windows complains the key is "too open", run this once and try again:
   ```powershell
   icacls $HOME\.ssh\filedost.key /inheritance:r /grant:r "$($env:USERNAME):R"
   ```
2. On the server, download your code. Use your own GitHub name and repository name.
   ```bash
   git clone https://github.com/YOUR-GITHUB-NAME/filedost.git app
   cd app
   ```
3. Run the one-time setup. It takes about 5 minutes.
   ```bash
   sudo bash deploy/server-setup.sh
   ```
4. Type `exit` and connect again with the same `ssh` command from item 1. This makes the Docker permission take effect.

## Step 6. Create the Cloudflare Tunnel

The tunnel is the secure link between Cloudflare and your server.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks for a team name: type anything, and choose the **Free** plan.
2. Go to **Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, and name it after your app.
3. On the "Install connector" page, pick **Docker**. You will see a command ending in `--token eyJh...`. **Copy only the long code after `--token`.** This is your tunnel token. You don't run that command.
4. Click **Next** to reach **Public hostnames** (also called *Published application routes*) and add a route:
   - Subdomain: *(empty)*
   - Domain: your domain
   - Service type: **HTTP**
   - URL: **`app:8000`**
5. Save. Then add a second route that is the same except **Subdomain: `www`**.

## Step 7. Start the site

On the server, inside the `app` folder:

```bash
bash deploy/deploy.sh
```

The first time, it asks two questions:
- your domain, `filedostai.com`
- the tunnel token from Step 6

The first build installs LibreOffice, OCR languages and the rest, so it takes **10 to 20 minutes**. When it prints **"The app is running"**, open `https://your-domain` on your phone. 🎉

## Step 8. Test it like a visitor

Use your phone on mobile data, so you're not testing from your own Wi-Fi:

- [ ] The site opens with a padlock, and `http://` jumps to `https://`.
- [ ] `www.your-domain` also opens.
- [ ] Merge two PDFs. This tool runs in the browser.
- [ ] Word to PDF, and PowerPoint to PDF. These use LibreOffice on the server.
- [ ] OCR on a photo of a page, in English and in Hindi.
- [ ] Compress a PDF.
- [ ] Exam photo resizer with a JEE preset.
- [ ] The name, logo, footer and donate buttons show your details.
- [ ] A 50 MB file uploads. Cloudflare's free plan allows up to 100 MB.

If something fails, see what the app logged:

```bash
cd ~/app && docker compose logs --tail 100 app
```

## Step 9. Let people find it

1. **Google Search Console** (https://search.google.com/search-console):
   1. Add your domain. Verifying is one click, because Cloudflare can add the record for you.
   2. Under *Sitemaps*, submit `https://your-domain/sitemap.xml`.
2. **Bing Webmaster Tools** (https://www.bing.com/webmasters): sign in and choose *Import from Google Search Console*.
3. **Uptime alert**: create a free monitor at https://uptimerobot.com for `https://your-domain/api/health`. It emails you if the site goes down.
4. Optional free visitor statistics: in Cloudflare, go to **Analytics & Logs → Web Analytics**. It needs no cookies and no banner.
5. Optional extra protection: in Cloudflare, go to **Security → WAF → Rate limiting rules** and add one rule. If a URL path starts with `/api/` and one IP sends more than 100 requests in 1 minute, block it.

## Step 10. Updating the site later

When the app changes, for example after new tools from the build thread:

1. On your PC, copy the new files into the app folder. Then, in GitHub Desktop, click **Commit to main** and **Push origin**.
2. On the server:
   ```bash
   ssh -i $HOME\.ssh\filedost.key ubuntu@SERVER_IP
   cd app && bash deploy/deploy.sh
   ```

`deploy.sh` downloads the new code, rebuilds with the latest security fixes, and restarts. Visitors see a short pause of about 30 seconds.

**Run `deploy.sh` once a month even when nothing changed.** That rebuild picks up security fixes for LibreOffice, Ghostscript and Tesseract. The server already installs Ubuntu's own security updates automatically.

## Step 11. Backups

Visitors' files are never stored, so the only thing to keep is ratings and feedback.

```bash
cd ~/app && bash deploy/backup.sh
```

To copy the backups to your PC now and then, run this in PowerShell on your PC:

```powershell
scp -i $HOME\.ssh\filedost.key "ubuntu@SERVER_IP:~/backups/*" $HOME\Downloads\
```

Your code is already backed up on GitHub. Keep the server key file and the tunnel token somewhere safe, such as a password manager. With those you can rebuild everything on a new server in about 30 minutes, by repeating Steps 4 to 7.

## Scaling: what happens when visitors grow

**Short answer: 1 lakh visitors a month is fine on the free server.** The site will slow down at busy moments before it ever falls over. When that starts happening, a ₹700 to ₹1,500 a month upgrade fixes it.

### Why it copes

- **Most tools never touch the server.** 38 of the 57 tools run inside the visitor's own browser:
  - merge, split, rotate, sign, image tools, photo resizer, QR, ZIP
  - all video tools

  For these, the server only sends the web page once. After that, Cloudflare serves the files from its cache.
- **Only about 19 tools use the server.** These are Office conversion, OCR, compress PDF, PDF to Word/Excel/PPT, PDF/A, protect/unlock, redact and repair.
- **How many jobs run at once** is set by `ULTRAPDF_MAX_JOBS`, which defaults to the number of CPU cores. That is **2** on the free Oracle machine. A third request waits up to 90 seconds for a free slot. If none frees up, the visitor sees "Server busy, try again" and nothing crashes. Each job is capped at 3 GB of RAM and 5 minutes.
- **Each visitor can run 60 server jobs an hour**, which stops one person from hogging the server.

### Rough numbers for 1 lakh visitors a month

| | Estimate |
|---|---|
| Visitors per day | about 3,300 |
| Server jobs per day (if about 1 in 3 visitors uses a server tool) | about 1,000 to 1,500 |
| Busiest hour | about 150 to 200 jobs, i.e. 3 a minute |
| What 2 slots can handle | about 500 an hour of typical 10 to 15 second jobs (Word to PDF, compress) |
| Bandwidth | well inside Oracle's free 10 TB a month; Cloudflare doesn't charge for bandwidth |

So the server is busy but not overloaded. The weak spots are long jobs:

1. **OCR on big scans** (50+ pages can take 1 to 3 minutes and holds a slot the whole time). This strains first.
2. **PowerPoint and big Excel to PDF** (LibreOffice, 10 to 60 seconds).
3. **Compress "extreme" and PDF/A on large files** (Ghostscript).

Video tools don't strain the server, because they run in the browser.

### What to watch

- **UptimeRobot** (Step 9) emails you if the site goes down.
- **Cloudflare dashboard → Analytics** shows visitors per day.
- **"Busy" errors**: on the server, this counts how many requests were turned away as busy:
  ```bash
  cd ~/app && docker compose logs --since 24h app | grep -c " 503 "
  ```
  Occasionally is fine. Dozens a day means it's time to upgrade.
- **CPU and memory**: run `docker stats` and press Ctrl+C to leave. CPU near 200% (both cores) for long stretches means the server is full.

### Upgrade path, cheapest first

1. **Allow 3 jobs at a time** (free). Do this if the CPU isn't maxed out but visitors see "busy".
   1. In `~/app/docker-compose.override.yml`, under `app: environment:`, add `ULTRAPDF_MAX_JOBS: "3"`.
   2. Under `app:`, add `mem_limit: 10g`.
   3. Run `bash deploy/deploy.sh`.

   Note: `deploy.sh` copies the override file from `deploy/` again, so make this edit in `deploy/docker-compose.override.yml` too.
2. **A bigger server** (about ₹700 to ₹1,500 a month).
   - Hetzner CAX21/CAX31 (4 to 8 ARM cores, 8 to 16 GB), or a paid Oracle A1 shape with 4+ OCPU. Jobs at once go up with the cores.
   - Set it up with Steps 4 to 7, then point the tunnel at it. The domain, Cloudflare and visitors don't notice the move.
3. **A second server running side by side** (free with Cloudflare).
   - Run the same `deploy.sh` on a second machine **with the same tunnel token**. Cloudflare then splits visitors between the two servers by itself, with no load balancer to buy.
   - The second machine can be another free Oracle account or a Hetzner box.
   - Ratings and feedback are stored per server, which is fine.
4. **Cache the static files longer** (free, small code change). Ask Claude to let Cloudflare cache the `?v=`-versioned files under `/static/` for a long time. That takes even the page loads off the server.

You don't need any of this on day one. Launch on the free server, watch the numbers for a month, and upgrade only when the "busy" count or CPU says so.

## Keep these private

- **Never** share or upload the `.key` file or the tunnel token. The token lives only in `~/app/.env` on the server, and `.gitignore` keeps it off GitHub.
- If the token ever leaks: in Cloudflare Zero Trust, open the tunnel and choose **Refresh token**. Then on the server run `nano ~/app/.env`, paste the new token, and run `bash deploy/deploy.sh`.

---

## Appendix A. If Oracle won't give you a free machine: Hetzner, about ₹450 a month

1. Sign up at https://www.hetzner.com/cloud.
2. Create a server:
   - **Location**: Singapore (closest to India)
   - **Image**: Ubuntu 24.04
   - **Type**: **CAX11** (ARM, 4 GB) or **CX23** (4 GB)
   - Add your SSH key
3. Log in with `ssh root@SERVER_IP`. Then create a normal user:
   ```bash
   adduser app
   usermod -aG sudo app
   ```
   Copy your key over with `rsync --archive --chown=app:app ~/.ssh /home/app` and log in again as `app`.
4. Continue from Step 5, item 2. Everything else is identical.

## Appendix B. Without the Cloudflare Tunnel (Caddy instead)

Use this only if you'd rather not use the tunnel. You will have to open ports 80 and 443 yourself:
- On Oracle: in the subnet's *Security List*, add ingress rules for TCP 80 and 443. Also run `sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save`.
- Then:
  1. Install Caddy (https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
  2. Put `deploy/Caddyfile` at `/etc/caddy/Caddyfile`, with your domain in it.
  3. Run `sudo systemctl reload caddy`.
  4. Delete `docker-compose.override.yml`. In `docker-compose.yml`, keep `ULTRAPDF_TRUST_PROXY: "cloudflare"` (safe only because the firewall below lets nothing but Cloudflare in), and set `ULTRAPDF_ALLOWED_HOSTS: "your-domain,www.your-domain,127.0.0.1"`.
- In Cloudflare, add `A` records for `@` and `www` pointing to the server IP, and set SSL/TLS mode to **Full (strict)**.
- Allow ports 80 and 443 only from Cloudflare's IP ranges (https://www.cloudflare.com/ips/), as SECURITY.md says.

## Appendix C. Hostinger

**Hostinger's normal web hosting** (Single, Premium, Business and Cloud plans) **will not run this app.** Those plans are built for PHP and WordPress sites. They give you no Docker, no way to install LibreOffice, Tesseract or Ghostscript, and no long-running Python server. On them, the page would load and the in-browser tools would work, but every server tool would fail: Office conversion, OCR, compress, PDF to Word and the rest.

**A Hostinger VPS works fine.** It is a full Linux server, just like the Oracle one.

| Plan | CPU / RAM | Fits? | Rough price |
|---|---|---|---|
| KVM 1 | 1 vCPU / 4 GB | Works, but runs only 2 server jobs at a time, slowly. OK for testing. | about ₹400–600 a month on a long prepaid plan; more on renewal |
| **KVM 2** | 2 vCPU / 8 GB | **The one to pick.** About the same power as the free Oracle machine. | about ₹600–900 a month on a long prepaid plan; renewal is often ₹1,000+ |

Hostinger's low prices assume you prepay 1 to 4 years, and the renewal price is noticeably higher. Check the renewal price before paying. Oracle's free machine (2 CPU / 12 GB) is as strong as KVM 2 and costs ₹0, so pick Hostinger only if Oracle signup or capacity doesn't work out. It is simpler to buy and has Indian support and UPI payment.

### What changes in this guide if you use a Hostinger VPS

- **Step 4:** buy the VPS instead of creating the Oracle machine.
  1. Choose **KVM 2**.
  2. Set the location to **India**, if offered, or the closest one.
  3. Set the operating system to **Ubuntu 24.04** (the plain one, not a panel or app template).
  4. Set a root password and add your SSH key.
- **Step 5:** log in with `ssh root@SERVER_IP`. Create a normal user first, as in Appendix A step 3, then continue from Step 5, item 2.
- **Everything else stays the same:** Cloudflare, the tunnel, `deploy.sh`, testing, updates and backups. The tunnel means you don't need to open any ports in Hostinger's firewall.

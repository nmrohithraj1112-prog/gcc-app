# GCC Intel — CEO Daily Brief
## Deploy to Vercel in 10 minutes

---

## What you're deploying

A live, PIN-protected web + mobile app for Sreema Nallasivam.
- 8 sections of GCC AI & Tech intelligence
- Refresh button fetches live news via Anthropic AI + web search
- Installs as a mobile app (PWA) on iPhone and Android
- Current PIN: 2025 (change in index.html → const PIN = '2025')

---

## Files in this folder

```
gcc-intel/
├── index.html       ← The full app (frontend)
├── api/
│   └── refresh.js   ← Serverless function (calls Anthropic API)
├── vercel.json      ← Vercel configuration
└── DEPLOY.md        ← This file
```

---

## Step 1 — Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Click "API Keys" → "Create Key"
3. Copy the key (starts with sk-ant-...)
4. Keep it safe — you'll need it in Step 3

---

## Step 2 — Deploy to Vercel

### Option A: Drag & Drop (easiest)

1. Go to https://vercel.com → Sign up free (use GitHub login)
2. Click **"Add New"** → **"Project"**
3. Scroll down and click **"Deploy a local folder"**
4. Drag the entire `gcc-intel` folder into the upload area
5. Click **Deploy** and wait ~30 seconds

### Option B: Via GitHub (recommended for updates)

1. Create a free account at https://github.com
2. Create a new repository called `gcc-intel` (set to Private)
3. Upload all files maintaining the folder structure
4. Go to https://vercel.com → "Add New" → "Import Git Repository"
5. Select your `gcc-intel` repo → click Deploy

---

## Step 3 — Add your Anthropic API key (CRITICAL)

Without this step, the Refresh button will not work.

1. In your Vercel project dashboard, click **"Settings"**
2. Click **"Environment Variables"** in the left menu
3. Click **"Add New"**
4. Name: `ANTHROPIC_API_KEY`
5. Value: paste your API key (sk-ant-...)
6. Select all environments (Production, Preview, Development)
7. Click **Save**
8. Go to **"Deployments"** → click the three dots → **"Redeploy"**

---

## Step 4 — Share with Sreema

Your app URL will be something like:
`https://gcc-intel-yourname.vercel.app`

You can also set a custom domain in Vercel Settings → Domains.

**Share this with Sreema:**
> "Open [URL] on your phone. Tap the share icon → Add to Home Screen.
> PIN is [your PIN]. Tap Refresh for today's news."

---

## Step 5 — Install as mobile app (for Sreema)

**iPhone (Safari):**
1. Open the URL in Safari
2. Tap the Share button (box with arrow up)
3. Scroll down → tap "Add to Home Screen"
4. Tap "Add" — the GCC Intel icon appears on home screen

**Android (Chrome):**
1. Open the URL in Chrome
2. Tap the three-dot menu
3. Tap "Add to Home screen" or "Install app"
4. Tap "Install"

---

## Changing the PIN

Open `index.html` in any text editor.
Find this line (around line 290):
```
const PIN = '2025';
```
Change `2025` to any 4-digit number.
Save and redeploy.

---

## How the Refresh button works

When Sreema taps Refresh:
1. The app calls your `/api/refresh` serverless function on Vercel
2. The function uses your Anthropic API key (stored securely in Vercel)
3. It searches the web and generates fresh news for each section
4. Each section loads independently — results appear as they complete
5. Takes about 15–30 seconds for all 8 sections

**Cost:** Each full refresh uses ~8 API calls.
Approximate cost: $0.05–0.15 per full refresh at current Anthropic pricing.
Vercel serverless: free tier (100GB bandwidth, unlimited deployments).

---

## Updating news content manually

If you want to update the fallback/default content (shown before first refresh):
1. Open `index.html`
2. Find the `FALLBACK` object (around line 170)
3. Edit the items array with new news
4. Save and redeploy

---

## Support

Built by Claude (Anthropic).
For fresh content: tap the ↻ Refresh button in the app.
For app updates: regenerate via Claude and redeploy to Vercel.

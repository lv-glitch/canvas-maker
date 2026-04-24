# Distribution setup

Step-by-step to ship 55 Music Canvas Generator to staff with automatic updates.

The app is already built and works locally. What this doc gets you is a **pipeline**:
you push a version tag, GitHub builds signed + notarized DMGs, the installed apps
on every staff member's laptop silently fetch the update on next launch.

**Time estimate:** ~45 min of clicking + 1–2 days waiting for Apple to approve your
Developer Program enrollment.

---

## What you need

1. **GitHub account** (free). Sign up at [github.com/signup](https://github.com/signup)
   if you don't have one.
2. **Apple Developer Program** ($99/yr). Required for silent auto-updates on macOS.
   Without it, staff would have to manually re-download and re-install on every
   release — not worth it for a non-technical team.

Windows staff? Skip for now — none of the below covers Windows signing. Revisit
if you add Windows users.

---

## Part A — GitHub (do first, ~10 min)

### A1. Create the repo

1. Log into github.com.
2. Click the **+** in the top right → **New repository**.
3. **Owner:** your personal account or a new organization. If you want a
   separate org for 55 Music, create one first at
   [github.com/organizations/new](https://github.com/organizations/new).
4. **Repository name:** `canvas-maker` (or anything — we'll wire it up).
5. **Visibility:** **Public** is simplest. Staff can download the DMG straight
   from the Releases page with no GitHub account required. If you insist on
   private, you'll need a separate hosting step (ping me to set it up).
6. **Do NOT initialize** with a README, .gitignore, or license — we already
   have those locally.
7. Click **Create repository**.

### A2. Tell me the owner/repo

Once created, the URL looks like `https://github.com/<owner>/<repo>`.
Send me that and I'll update `package.json` so electron-updater points at it.

### A3. Push your local code

GitHub will show copy-pasteable commands after A1. Something like:

```bash
cd /Users/lawrencevavra/canvas-maker
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

Authentication on first push: it'll either open a browser to log in, or prompt
for a Personal Access Token. Create one at
[github.com/settings/tokens](https://github.com/settings/tokens/new) with scope
`repo`. Paste the token when asked — not your GitHub password.

---

## Part B — Apple Developer (~30 min of clicking + 1–2 days review)

### B1. Enroll

1. Go to [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll).
2. Sign in with your Apple ID. Use the company Apple ID if you have one — this
   account owns the signing cert forever.
3. Enroll as an **Organization** if 55 Music is a registered business (needs
   D-U-N-S number — free to get but takes 1–2 days to verify). Otherwise enroll
   as an **Individual** with your name; you can convert later.
4. Pay the $99 fee.
5. Wait for Apple to approve (usually 24–48 hours; organization can take longer
   if they need to verify the business).

Continue with B2 once you get the approval email.

### B2. Create a "Developer ID Application" certificate

1. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates).
2. Click the **+** to create a new certificate.
3. Under **Software**, pick **Developer ID Application** → Continue.
4. It asks for a Certificate Signing Request (CSR). To create one:
   - Open **Keychain Access** (built into macOS, in /Applications/Utilities).
   - Menu: **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority…**
   - **User email:** your Apple Developer email
   - **Common Name:** `55 Music Developer ID`
   - Leave CA email blank
   - Request is: **Saved to disk**
   - Save the `.certSigningRequest` file to your Desktop.
5. Back in the browser, upload that `.certSigningRequest` file → Continue.
6. Download the generated `.cer` file and double-click it — it gets added to
   your Keychain.

### B3. Export the cert as .p12

1. In **Keychain Access**, find **Developer ID Application: 55 Music** (or your name) under the **My Certificates** category in the **login** keychain.
2. Right-click it → **Export "Developer ID Application…"** → **Save as .p12**.
3. Give it a strong password when prompted — **save this password**, you'll
   paste it into GitHub in B5.
4. Save the `.p12` to your Desktop.

### B4. Get an app-specific password

1. Go to [account.apple.com](https://account.apple.com) → **Sign-In and Security** → **App-Specific Passwords** → **Generate Password**.
2. Label it `electron-builder-notarize` (or similar). Save the password somewhere secure.
3. You'll paste this into GitHub as `APPLE_APP_SPECIFIC_PASSWORD`.

### B5. Add all 5 secrets to GitHub

1. Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Create these 5 secrets (names must match exactly):

   | Secret name | Value |
   | --- | --- |
   | `APPLE_ID` | Your Apple Developer email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | The password from B4 |
   | `APPLE_TEAM_ID` | Your 10-char Team ID — top-right of [developer.apple.com/account](https://developer.apple.com/account) |
   | `CSC_LINK` | The `.p12` base64-encoded. In Terminal: `base64 -i ~/Desktop/cert.p12 \| pbcopy` — then paste |
   | `CSC_KEY_PASSWORD` | The password you set on the `.p12` in B3 |

Once all 5 are saved, the pipeline is ready.

---

## Part C — Ship the first release (~5 min)

```bash
cd /Users/lawrencevavra/canvas-maker
# Bump the version in package.json (e.g. 0.2.1 → 0.3.0)
npm version minor

# Push the tag — GitHub Actions picks it up and builds signed DMGs
git push && git push --tags
```

Open GitHub → Actions tab. You'll see the `Release` workflow run. Takes ~8 min
to build, sign, and notarize both arm64 and x64 DMGs. When it finishes, the
Releases page has the DMGs attached.

---

## Part D — Install on each staff machine (one time)

Send each staff member the Releases page URL:

```
https://github.com/<owner>/<repo>/releases/latest
```

Tell them:

1. Click the DMG for their Mac type (usually **arm64** if it's Apple Silicon, **x64** if it's an older Intel Mac).
2. Open the DMG → drag the app into **Applications**.
3. Open it from **Applications** (double-click is fine now that it's signed).

They never need to do this again. Every future update is silent.

---

## After this, what releases look like

For every change (new animation, bug fix, whatever):

```bash
npm version patch          # 0.3.0 → 0.3.1  (or: minor / major)
git push && git push --tags
```

That's it. GitHub Actions builds + publishes. On staff machines, the next time
they open the app it quietly downloads the update in the background; next
launch after that, the new version is running. No clicks, no interruptions.

---

## Troubleshooting

### GitHub Action fails with "notarization failed"
- Check the Apple Developer account is still paid up ($99 is annual).
- Verify `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` secrets are right.
- Re-generate the app-specific password at account.apple.com and update the secret.

### Action fails with "certificate identity not found"
- Cert may have expired (valid for 5 years from creation). Re-do B2 and B5.
- Or `CSC_LINK` isn't valid base64. Re-run `base64 -i cert.p12 | pbcopy` on a fresh export.

### Staff member says "app is damaged, move to trash"
- Almost always means the DMG was downloaded but got corrupted. Have them re-download.
- If it persists, the notarization step in CI may have silently failed — check the last release's Action log.

### Updates aren't arriving on a staff machine
- App only checks on launch. If it's been open for a week, quit and relaunch.
- Check **Settings → Privacy & Security** — macOS may have quarantined the app.
- Last resort: have them re-download and re-install from the latest Release.

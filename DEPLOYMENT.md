# Kartomat – PWA Deployment & Setup Guide

This document tracks the deployment details and setup instructions for the **Kartomat** Spaced-Repetition Learning PWA.

## 📦 GitHub Repository
*   **Repository URL**: [https://github.com/Finn01/kartomat](https://github.com/Finn01/kartomat)
*   **Primary Branch**: `main`

## 🌎 Cloudflare Pages Production URLs
*   **Production URL**: [https://main.kartomat.pages.dev](https://main.kartomat.pages.dev)
*   **Initial Build URL**: [https://5ed7b075.kartomat.pages.dev](https://5ed7b075.kartomat.pages.dev)

---

## 📲 How to Install on Your Phone
1. Open your phone's browser and go to: **[https://main.kartomat.pages.dev](https://main.kartomat.pages.dev)**
2. **On iOS (Safari)**: Tap the **Share** button (up-arrow box) $\rightarrow$ select **Add to Home Screen**.
3. **On Android (Chrome)**: Tap the **three-dot menu** $\rightarrow$ select **Install app** (or *Add to Home Screen*).
4. Launch Kartomat from your homescreen. The local IndexedDB database will automatically seed with the initial philosophers' deck (`lernkarten_vl_1-3.json`).

---

## 🔄 Deploying Updates
Whenever you update code in the future, compile the production assets and push them using Wrangler:

```bash
# 1. Build and compile production assets
npm run build

# 2. Deploy dist folder to Cloudflare Pages
npx wrangler pages deploy dist --project-name kartomat

# 3. Push source changes to GitHub
git add .
git commit -m "chore: update application build"
git push
```

The installed PWA on your phone will check for updates on startup. If an update is detected, it will show a floating **"A new version of Kartomat is available! [Update Now]"** banner at the bottom. Tapping it will upgrade the app in-place. You can also manually trigger a check in the **Settings** modal.

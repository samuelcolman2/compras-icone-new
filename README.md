<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1RfUvJDziV1fz0xvtdKbKfPz8vPwgEJVq

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Copy [.env.example](.env.example) to `.env.local` and fill the following variables:
   - `GEMINI_API_KEY`
   - `VITE_FIREBASE_URL`
   - `VITE_FIRESTORE_PROJECT_ID`
   - `VITE_APPS_SCRIPT_URL`
   - `VITE_PURCHASE_NOTIFICATION_APPS_SCRIPT_URL`
3. Run the app:
   `npm run dev`

## Deploy

Before deploying (for example, on Netlify) add the same environment variables listed above to your site settings. Only the variables prefixed with `VITE_` are exposed to the browser bundle. Keep `.env.local` out of version control—use `.env.example` as a safe reference for other environments.

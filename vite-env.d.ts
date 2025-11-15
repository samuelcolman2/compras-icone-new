/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_FIREBASE_URL: string;
    readonly VITE_FIRESTORE_PROJECT_ID: string;
    readonly VITE_APPS_SCRIPT_URL: string;
    readonly VITE_PURCHASE_NOTIFICATION_APPS_SCRIPT_URL: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

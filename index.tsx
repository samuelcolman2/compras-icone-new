
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

// ==========================================================================
// AUTH UTILITIES & SERVICES
// ==========================================================================

const getRequiredEnvVar = (value: string | undefined, key: string) => {
    if (!value) {
        throw new Error(`Vari?vel de ambiente ausente: ${key}`);
    }
    return value;
};

async function sha256(str: string): Promise<string> {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

const FIREBASE_URL = getRequiredEnvVar(import.meta.env.VITE_FIREBASE_URL, 'VITE_FIREBASE_URL');
const FIRESTORE_PROJECT_ID = getRequiredEnvVar(import.meta.env.VITE_FIRESTORE_PROJECT_ID, 'VITE_FIRESTORE_PROJECT_ID');
// URL para autentica??o (login, verifica??o, reset de senha)
const APPS_SCRIPT_URL = getRequiredEnvVar(import.meta.env.VITE_APPS_SCRIPT_URL, 'VITE_APPS_SCRIPT_URL');
// URL **NOVA** apenas para notifica??es de compra por e-mail
const PURCHASE_NOTIFICATION_APPS_SCRIPT_URL = getRequiredEnvVar(import.meta.env.VITE_PURCHASE_NOTIFICATION_APPS_SCRIPT_URL, 'VITE_PURCHASE_NOTIFICATION_APPS_SCRIPT_URL');

export interface User {
    uid: string;
    email: string;
    displayName: string;
    isVerified: boolean;
    createdAt: number;
    role?: 'admin' | 'user' | 'comprador' | 'aprovador';
}

type ApproverContact = {
    email: string;
    displayName: string;
    role: 'admin' | 'aprovador';
};

const authService = {
    sanitizeEmail: (email: string) => {
        if (!email) return '';
        return email
            .toLowerCase()
            .replace(/\./g, ",")
            .replace(/#/g, "_")
            .replace(/\$/g, "_")
            .replace(/\[/g, "_")
            .replace(/\]/g, "_");
    },
    signUp: async (email: string, password: string, displayName: string) => {
        const sanitizedEmail = authService.sanitizeEmail(email);
        const userPath = `/users/${sanitizedEmail}.json`;

        const existingUserRes = await fetch(FIREBASE_URL + userPath);
        if (existingUserRes.ok && await existingUserRes.json()) {
            throw new Error('Este e-mail jÃ¡ estÃ¡ em uso.');
        }

        const passwordHash = await sha256(password);
        const user = {
            displayName,
            email,
            passwordHash,
            isVerified: false,
            createdAt: Date.now(),
            uid: sanitizedEmail,
            role: 'user',
        };

        const response = await fetch(FIREBASE_URL + userPath, {
            method: 'PUT',
            body: JSON.stringify(user),
        });

        if (!response.ok) throw new Error('Falha ao criar a conta.');

        await authService.requestVerificationEmail(email);
        return user;
    },
    signIn: async (email: string, password: string): Promise<User> => {
        const sanitizedEmail = authService.sanitizeEmail(email);
        const userPath = `/users/${sanitizedEmail}.json`;
        const response = await fetch(FIREBASE_URL + userPath);
        if (!response.ok) throw new Error('E-mail ou senha incorretos.');

        const user = await response.json();
        if (!user) throw new Error('E-mail ou senha incorretos.');

        const passwordHash = await sha256(password);
        if (user.passwordHash !== passwordHash) throw new Error('E-mail ou senha incorretos.');
        if (!user.isVerified) throw new Error('Seu e-mail ainda não foi verificado. Por favor, verifique sua caixa de entrada.');

        if (!user.role) {
            user.role = 'user';
            fetch(FIREBASE_URL + userPath, {
                method: 'PATCH',
                body: JSON.stringify({ role: 'user' })
            }).catch(e => console.error("Failed to update user role:", e));
        }

        return {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            isVerified: user.isVerified,
            createdAt: user.createdAt,
            role: user.role
        };
    },
    _callAppsScript: async (action: string, params: Record<string, string>) => {
        const url = new URL(APPS_SCRIPT_URL);
        url.searchParams.append('action', action);
        for (const key in params) {
            url.searchParams.append(key, params[key]);
        }
        const response = await fetch(url.toString());
        if (!response.ok) throw new Error('Erro de comunicaÃ§Ã£o com o servidor.');
        return response.json();
    },
    requestVerificationEmail: (email: string) => authService._callAppsScript('requestVerification', { email }),
    confirmVerification: (email: string, code: string) => authService._callAppsScript('confirmVerification', { email, code }),
    requestPasswordReset: (email: string) => authService._callAppsScript('requestReset', { email }),
    confirmPasswordReset: (email: string, code: string, newPassword: string) => authService._callAppsScript('confirmReset', { email, code, newPassword }),
    getUserProfilePhoto: async (uid: string): Promise<string | null> => {
        try {
            const firestorePath = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/user_profiles/${uid}`;
            const response = await fetch(firestorePath);
            if (!response.ok) return null;
            const data = await response.json();
            return data.fields?.photoBase64?.stringValue || null;
        } catch (error) {
            console.error("Failed to fetch profile photo:", error);
            return null;
        }
    },
    updateUserProfile: async ({ uid, displayName, photoBase64 }: { uid: string; displayName: string; photoBase64: string | null }) => {
        const promises = [];

        const userPath = `/users/${uid}.json`;
        promises.push(fetch(FIREBASE_URL + userPath, {
            method: 'PATCH',
            body: JSON.stringify({ displayName }),
        }));

        if (photoBase64) {
            const firestorePath = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/user_profiles/${uid}`;
            promises.push(fetch(firestorePath, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: { photoBase64: { stringValue: photoBase64 } }
                }),
            }));
        }

        const responses = await Promise.all(promises);
        for (const res of responses) {
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                console.error("Failed to update profile", errorData);
                throw new Error('Falha ao atualizar o perfil.');
            }
        }
    },
    getAllUsers: async (): Promise<(User & { photoUrl: string | null })[]> => {
        const usersResponse = await fetch(FIREBASE_URL + '/users.json');
        if (!usersResponse.ok) throw new Error('Falha ao buscar usuários.');
        const usersData = await usersResponse.json();

        if (!usersData) return [];

        const userList: User[] = Object.values(usersData);

        const usersWithPhotos = await Promise.all(
            userList.map(async (user) => {
                const photoUrl = await authService.getUserProfilePhoto(user.uid);
                return {
                    ...user,
                    role: user.role || 'user',
                    photoUrl,
                };
            })
        );

        return usersWithPhotos;
    },
    getApproverContacts: async (): Promise<ApproverContact[]> => {
        try {
            const response = await fetch(FIREBASE_URL + '/users.json');
            if (!response.ok) throw new Error('Falha ao buscar usuÇ­rios.');
            const usersData = await response.json();
            if (!usersData) return [];

            const contactsMap = new Map<string, ApproverContact>();

            Object.values(usersData).forEach((user: any) => {
                const role = user.role || 'user';
                if ((role === 'admin' || role === 'aprovador') && user.email) {
                    const emailKey = String(user.email).toLowerCase();
                    if (!contactsMap.has(emailKey)) {
                        contactsMap.set(emailKey, {
                            email: user.email,
                            displayName: user.displayName || 'Gestor',
                            role,
                        });
                    }
                }
            });

            return Array.from(contactsMap.values());
        } catch (error) {
            console.error("Failed to fetch approver contacts:", error);
            return [];
        }
    },
    updateUserRole: async (uid: string, role: User['role']) => {
        const userPath = `/users/${uid}.json`;
        const response = await fetch(FIREBASE_URL + userPath, {
            method: 'PATCH',
            body: JSON.stringify({ role }),
        });

        if (!response.ok) {
            throw new Error('Falha ao atualizar a permissÃ£o do usuário.');
        }
    },
};

// ==========================================================================
// DATABASE SERVICES
// ==========================================================================
const databaseService = {
    addPurchaseRequest: async (requestData: any) => {
        const response = await fetch(`${FIREBASE_URL}/compras.json`, {
            method: 'POST', // POST generates a unique ID
            body: JSON.stringify(requestData),
        });
        if (!response.ok) {
            throw new Error('Falha ao enviar a solicitaÃ§Ã£o de compra.');
        }
        return response.json();
    },
    getPurchaseRequests: async (): Promise<any[]> => {
        const response = await fetch(`${FIREBASE_URL}/compras.json`);
        if (!response.ok) {
            throw new Error('Falha ao buscar as Solicitações de compra.');
        }
        const data = await response.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({
            id: key,
            ...data[key],
        }));
    },
    updatePurchaseRequestStatus: async (id: string, status: 'aprovado' | 'reprovado', justification?: string) => {
        const payload: { status: string; justification?: string; approvedAt?: string; rejectedAt?: string } = { status };

        if (status === 'aprovado') {
            payload.approvedAt = new Date().toISOString();
        } else if (status === 'reprovado') {
            payload.rejectedAt = new Date().toISOString();
            payload.justification = justification || '';
        }

        const response = await fetch(`${FIREBASE_URL}/compras/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error('Falha ao atualizar o status da solicitação.');
        }
        return response.json();
    },
    confirmPurchase: async (id: string, purchaseData: any) => {
        const payload = {
            status: 'comprado',
            purchasedAt: new Date().toISOString(),
            ...purchaseData,
        };

        const response = await fetch(`${FIREBASE_URL}/compras/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error('Falha ao confirmar a compra.');
        }
        return response.json();
    },
    uploadAndLinkInvoice: async (
        id: string,
        invoice: { pages: string[]; mimeType: string; originalName?: string }
    ) => {
        if (!invoice.pages.length) {
            throw new Error('Nenhuma página foi processada para a nota fiscal.');
        }
        // 1. Save to Firestore
        const firestorePath = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/invoices/${id}`;
        const firestoreResponse = await fetch(firestorePath, {
            method: 'PATCH', // Use PATCH to create or update
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    mimeType: { stringValue: invoice.mimeType },
                    pages: {
                        arrayValue: {
                            values: invoice.pages.map(page => ({ stringValue: page }))
                        }
                    },
                    ...(invoice.originalName ? { originalName: { stringValue: invoice.originalName } } : {}),
                    updatedAt: { timestampValue: new Date().toISOString() }
                }
            }),
        });
        if (!firestoreResponse.ok) {
            throw new Error('Falha ao salvar a nota fiscal no Firestore.');
        }

        // 2. Link in Realtime Database
        const rtdbResponse = await fetch(`${FIREBASE_URL}/compras/${id}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ hasInvoice: true, invoicePagesCount: invoice.pages.length }),
        });
        if (!rtdbResponse.ok) {
            throw new Error('Falha ao vincular a nota fiscal no Realtime DB.');
        }
    },

    getInvoice: async (id: string): Promise<{ pages: string[]; mimeType: string }> => {
        const firestorePath = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/invoices/${id}`;
        const response = await fetch(firestorePath);
        if (!response.ok) {
            throw new Error('Nota fiscal não encontrada.');
        }
        const data = await response.json();
        const fields = data.fields;
        if (!fields?.mimeType?.stringValue) {
            throw new Error('Formato da nota fiscal inválido no banco de dados.');
        }
        const mimeType = fields.mimeType.stringValue;
        const pageValues = fields.pages?.arrayValue?.values
            ?.map((value: { stringValue?: string }) => value?.stringValue)
            .filter((value): value is string => Boolean(value));
        if (pageValues && pageValues.length > 0) {
            return { mimeType, pages: pageValues };
        }
        if (fields.invoiceData?.stringValue) {
            return { mimeType, pages: [fields.invoiceData.stringValue] };
        }
        throw new Error('Nenhuma página encontrada para esta nota fiscal.');
    },
};

// ==========================================================================
// NOTIFICATION SERVICE
// ==========================================================================
const sendNotificationRequest = async (payload: any) => {
    try {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 8000);

        const response = await fetch(PURCHASE_NOTIFICATION_APPS_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            body: JSON.stringify(payload),
            signal: controller.signal,
            keepalive: true,
        });

        clearTimeout(timeoutId);

        if (response.type === 'opaque') {
            console.info("Requisi??uo enviada em modo no-cors (resposta nuo ? leg??vel no navegador).");
            return;
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn("A resposta da notifica??uo nuo retornou status OK.", response.status, text);
        }
    } catch (error) {
        console.warn("Ocorreu um erro ao enviar/processar a resposta da notifica??uo por e-mail. O e-mail ainda pode ter sido enviado. Erro:", error);
    }
};

const notificationService = {
    sendPurchaseConfirmationEmail: (requestData: any) => {
        sendNotificationRequest({
            ...requestData,
            notificationType: 'pedido_recebido',
        });
    },
    sendPurchaseStatusUpdateEmail: (requestData: any, status: 'aprovado' | 'reprovado', justification?: string) => {
        const payload: any = {
            ...requestData,
            status,
            notificationType: status === 'aprovado' ? 'pedido_aprovado' : 'pedido_reprovado',
        };

        if (status === 'reprovado') {
            payload.rejectionJustification = justification ?? requestData.justification ?? '';
        }

        sendNotificationRequest(payload);
    },
    sendPurchaseTransitEmail: (requestData: any, purchaseData: any) => {
        sendNotificationRequest({
            ...requestData,
            ...purchaseData,
            status: 'comprado',
            notificationType: 'pedido_a_caminho',
        });
    },
    notifyApproversAboutRequest: (requestData: any) => {
        authService.getApproverContacts()
            .then(approvers => {
                if (!approvers.length) {
                    console.info("Nenhum admin/aprovador encontrado para notificar.");
                    return;
                }
                const basePayload = {
                    ...requestData,
                    status: 'pendente',
                    notificationType: 'nova_solicitacao_aprovacao',
                    ctaUrl: `${window.location.origin}${window.location.pathname}`,
                };

                approvers.forEach((approver) => {
                    sendNotificationRequest({
                        ...basePayload,
                        email: approver.email,
                        approverName: approver.displayName,
                        approverRole: approver.role,
                    });
                });
            })
            .catch(error => console.error("Falha ao enviar a notificaï¿½ï¿½Çœo para aprovadores:", error));
    },
};
// ==========================================================================
// FORMATTING UTILITIES
// ==========================================================================
const formatDate = (dateString: string | undefined, includeTime = false) => {
    if (!dateString) return 'Não informado';
    try {
        const date = new Date(dateString);
        // Check if date is valid
        if (isNaN(date.getTime())) {
            // Handle cases where date string is just YYYY-MM-DD
            const parts = dateString.split('-');
            if (parts.length === 3) {
                const [year, month, day] = parts;
                return `${day}/${month}/${year}`;
            }
            return 'Data invÃ¡lida';
        }
        const options: Intl.DateTimeFormatOptions = {
            day: '2-digit', month: '2-digit', year: 'numeric'
        };
        if (includeTime) {
            options.hour = '2-digit';
            options.minute = '2-digit';
        }
        return date.toLocaleString('pt-BR', options);
    } catch (e) {
        return 'Data invÃ¡lida'
    }
};

const formatCurrency = (value: number | string | undefined | null) => {
    if (value === null || value === undefined || value === '') return 'não informado';

    let numberValue: number;
    if (typeof value === 'string') {
        const cleanedValue = value.replace(/[^\d,.-]+/g, '').replace(/\./g, '').replace(',', '.');
        numberValue = parseFloat(cleanedValue);
    } else {
        numberValue = value;
    }

    if (isNaN(numberValue)) return 'Valor invÃ¡lido';

    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    }).format(numberValue);
};

// ==========================================================================
// PDF COMPRESSION UTILITY
// ==========================================================================
declare const pdfjsLib: any;

const PDF_COMPRESSION_CONFIG = {
    scale: 1.3,
    quality: 0.9,
};

/**
 * Loads a PDF file and converts each page into a compressed JPEG image.
 * @param file The PDF file object from an input.
 * @param scale The scale to render the PDF page. Lower is smaller/faster.
 * @param quality The quality of the output JPEG (0.0 to 1.0).
 * @returns A promise that resolves to an array of base64 data URLs for each page.
 */
const compressPdfToJpegArray = async (
    file: File,
    scale: number = PDF_COMPRESSION_CONFIG.scale,
    quality: number = PDF_COMPRESSION_CONFIG.quality
): Promise<string[]> => {
    const images: string[] = [];
    const fileReader = new FileReader();

    return new Promise((resolve, reject) => {
        fileReader.onload = async (event) => {
            try {
                if (!event.target?.result) {
                    return reject(new Error("Falha ao ler o arquivo."));
                }
                const typedarray = new Uint8Array(event.target.result as ArrayBuffer);
                const pdf = await pdfjsLib.getDocument(typedarray).promise;

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const viewport = page.getViewport({ scale });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');

                    if (!context) {
                        return reject(new Error("Não foi possÃ­vel obter o contexto do canvas."));
                    }

                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    await page.render({ canvasContext: context, viewport: viewport }).promise;
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    const base64 = dataUrl.split(',')[1];
                    if (!base64) {
                        return reject(new Error("Falha ao converter a pÃ¡gina do PDF em imagem."));
                    }
                    images.push(base64);
                }
                resolve(images);
            } catch (error) {
                reject(error);
            }
        };

        fileReader.onerror = (error) => reject(error);
        fileReader.readAsArrayBuffer(file);
    });
};


// ==========================================================================
// UI COMPONENTS
// ==========================================================================
const Spinner: React.FC<{ message?: string; size?: 'small' | 'medium' }> = ({ message, size = 'medium' }) => (
    <div className="flex flex-col items-center justify-center space-y-4 text-center">
        <div className={`animate-spin rounded-full border-t-4 border-b-4 border-blue-500 ${size === 'small' ? 'h-6 w-6' : 'h-16 w-16'}`}></div>
        {message && <p className="text-lg text-gray-300 font-medium">{message}</p>}
    </div>
);

const UserIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
);

const LockIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 00-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
);

const EyeIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        id="iconEye"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        aria-hidden="true"
    >
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
);

const EyeOffIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        id="iconEyeOff"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        aria-hidden="true"
    >
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.4 18.4 0 0 1 5.06-5.94"></path>
        <path d="M9.88 9.88A3 3 0 0 0 12 15a3 3 0 0 0 2.12-5.12"></path>
        <path d="M1 1l22 22"></path>
        <path d="M14.12 14.12 20 20"></path>
        <path d="M9.88 9.88L4 4"></path>
        <path d="M22.94 11.06A18.5 18.5 0 0 0 17 6.1"></path>
    </svg>
);

const DefaultAvatar: React.FC<{ className?: string }> = ({ className }) => (
    <div className={`flex items-center justify-center overflow-hidden ${className}`} style={{ backgroundColor: 'var(--border-color)' }}>
        <svg xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-1 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
    </div>
);

const SettingsIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a6.759 6.759 0 0 1 0 1.905c.008.379.137.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.333.184-.582.496-.645.87l-.213 1.28c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.645-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.759 6.759 0 0 1 0-1.905c-.008-.379-.137-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.75.072 1.076-.124.072-.044.146-.087.22-.128.332-.184.582-.496.645-.87l.213-1.28Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
);

const AdminIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.286Zm0 13.036h.008v.008H12v-.008Z" />
    </svg>
);

const DollarSignIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 11.21 12.75 11 12 11c-.75 0-1.536.21-2.121.782A2.25 2.25 0 0 0 9 13.5m0 0v2.25" />
    </svg>
);

const ClipboardListIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z" />
    </svg>
);

const CheckCircleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
);

const XCircleIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
);

const CalculatorIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008Zm0 3h.008v.008H8.25v-.008Zm0 3h.008v.008H8.25v-.008Zm3-6h.008v.008H11.25v-.008Zm0 3h.008v.008H11.25v-.008Zm0 3h.008v.008H11.25v-.008Zm3-6h.008v.008H14.25v-.008Zm0 3h.008v.008H14.25v-.008ZM12 6.75h.008v.008H12V6.75ZM5.25 6h13.5c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125H5.25c-.621 0-1.125-.504-1.125-1.125V7.125c0-.621.504-1.125 1.125-1.125Z" />
    </svg>
);

const UploadIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
    </svg>
);

// ==========================================================================
// AUTH COMPONENT
// ==========================================================================
interface AuthProps {
    onLoginSuccess: (user: User) => void;
    theme: 'light' | 'dark';
    toggleTheme: () => void;
}

type AuthView = 'login' | 'signup' | 'forgot' | 'reset' | 'verify';
type SignupStep = 'name' | 'credentials';

const ThemeToggleIcon: React.FC<{ theme: 'light' | 'dark' }> = ({ theme }) => (
    theme === 'dark' ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
    ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
    )
);

const Auth: React.FC<AuthProps> = ({ onLoginSuccess, theme, toggleTheme }) => {
    const [view, setView] = useState<AuthView>('login');
    const [signupStep, setSignupStep] = useState<SignupStep>('name');
    const [fullName, setFullName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isPasswordVisible, setIsPasswordVisible] = useState(false);
    const [isConfirmPasswordVisible, setIsConfirmPasswordVisible] = useState(false);

    const handleResendVerification = async () => {
        if (!email) {
            setError("Por favor, informe o e-mail para reenviar o cÃ³digo.");
            return;
        }
        setIsLoading(true);
        setError(null);
        setMessage(null);
        try {
            await authService.requestVerificationEmail(email);
            setMessage("Um novo cÃ³digo foi enviado para seu e-mail.");
        } catch (err: any) {
            setError(err.message || "Falha ao reenviar cÃ³digo.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleNextStep = () => {
        if (!fullName.trim() || fullName.trim().split(' ').length < 2) {
            setError("Por favor, insira seu nome completo (pelo menos nome e sobrenome).");
            return;
        }
        setError(null);
        setSignupStep('credentials');
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (view === 'signup' && signupStep === 'name') {
            handleNextStep();
            return;
        }

        setIsLoading(true);
        setError(null);
        setMessage(null);

        try {
            if (view === 'login') {
                const user = await authService.signIn(email, password);
                onLoginSuccess(user);
            } else if (view === 'signup') {
                if (password !== confirmPassword) throw new Error("As senhas não coincidem.");
                if (password.length < 6) throw new Error("A senha deve ter pelo menos 6 caracteres.");

                const formattedFullName = fullName
                    .trim()
                    .toLowerCase()
                    .split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');

                await authService.signUp(email, password, formattedFullName);
                setMessage("Conta criada com sucesso! Verifique sua caixa de entrada (e spam) para o cÃ³digo de confirmação.");
                setView('verify');

            } else if (view === 'verify') {
                const response = await authService.confirmVerification(email, code);
                if (response.ok) {
                    setMessage("E-mail verificado com sucesso! Agora vocÃª pode fazer o login.");
                    setCode('');
                    setView('login');
                } else {
                    throw new Error(response.msg || "Falha ao verificar o cÃ³digo.");
                }

            } else if (view === 'forgot') {
                const response = await authService.requestPasswordReset(email);
                if (response.ok) {
                    setMessage("CÃ³digo de redefiniÃ§Ã£o enviado! Verifique seu e-mail.");
                    setView('reset');
                } else {
                    throw new Error(response.msg || "Falha ao solicitar redefiniÃ§Ã£o de senha.");
                }
            } else if (view === 'reset') {
                if (password.length < 6) throw new Error("A nova senha deve ter pelo menos 6 caracteres.");
                const response = await authService.confirmPasswordReset(email, code, password);
                if (response.ok) {
                    setMessage("Senha redefinida com sucesso! VocÃª jÃ¡ pode fazer login.");
                    setPassword('');
                    setCode('');
                    setView('login');
                } else {
                    throw new Error(response.msg || "Falha ao redefinir a senha.");
                }
            }
        } catch (err: any) {
            setError(err.message);
            if (err.message && err.message.toLowerCase().includes('não verificado')) {
                setView('verify');
            }
        } finally {
            setIsLoading(false);
        }
    };

    const cardBg = theme === 'dark' ? 'bg-slate-800 ring-1 ring-white/10' : 'bg-white shadow-2xl ring-1 ring-slate-200/80';
    const mutedTextColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
    const inputBg = theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100';
    const inputBorder = theme === 'dark' ? 'border-slate-600 focus:border-blue-500' : 'border-slate-300 focus:border-blue-500';
    const inputTextColor = theme === 'dark' ? 'text-white placeholder-gray-400' : 'text-slate-800 placeholder-gray-500';
    const buttonTextColor = theme === 'dark' ? 'text-gray-300' : 'text-gray-600';

    const renderFormFields = () => {
        switch (view) {
            case 'login':
                return (
                    <>
                        <div className="relative">
                            <UserIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} required className={`w-full pl-10 pr-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                        </div>
                        <div className="relative">
                            <LockIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type={isPasswordVisible ? 'text' : 'password'} placeholder="Senha" value={password} onChange={e => setPassword(e.target.value)} required className={`w-full pl-10 pr-10 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                            <button
                                type="button"
                                onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                                className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedTextColor} hover:text-blue-400`}
                                aria-label={isPasswordVisible ? "Esconder senha" : "Mostrar senha"}
                            >
                                {isPasswordVisible ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                            </button>
                        </div>
                    </>
                );
            case 'signup':
                return signupStep === 'name' ? (
                    <div className="relative">
                        <UserIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                        <input type="text" placeholder="Nome Completo" value={fullName} onChange={e => setFullName(e.target.value)} required autoFocus className={`w-full pl-10 pr-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                    </div>
                ) : (
                    <>
                        <div className="relative">
                            <UserIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} required className={`w-full pl-10 pr-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                        </div>
                        <div className="relative">
                            <LockIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type={isPasswordVisible ? 'text' : 'password'} placeholder="Senha" value={password} onChange={e => setPassword(e.target.value)} required className={`w-full pl-10 pr-10 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                            <button
                                type="button"
                                onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                                className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedTextColor} hover:text-blue-400`}
                                aria-label={isPasswordVisible ? "Esconder senha" : "Mostrar senha"}
                            >
                                {isPasswordVisible ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                            </button>
                        </div>
                        <div className="relative">
                            <LockIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type={isConfirmPasswordVisible ? 'text' : 'password'} placeholder="Confirmar Senha" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required className={`w-full pl-10 pr-10 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                            <button
                                type="button"
                                onClick={() => setIsConfirmPasswordVisible(!isConfirmPasswordVisible)}
                                className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedTextColor} hover:text-blue-400`}
                                aria-label={isConfirmPasswordVisible ? "Esconder senha" : "Mostrar senha"}
                            >
                                {isConfirmPasswordVisible ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                            </button>
                        </div>
                    </>
                );
            case 'verify':
                return (
                    <>
                        <p className={`text-sm text-center ${mutedTextColor}`}>Um cÃ³digo foi enviado para <strong>{email}</strong>. Insira-o abaixo para ativar sua conta.</p>
                        <input type="text" placeholder="CÃ³digo de 6 dÃ­gitos" value={code} onChange={e => setCode(e.target.value)} required className={`w-full px-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors text-center tracking-[0.3em]`} />
                    </>
                );
            case 'forgot':
                return (
                    <div className="relative">
                        <UserIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                        <input type="email" placeholder="Seu e-mail cadastrado" value={email} onChange={e => setEmail(e.target.value)} required className={`w-full pl-10 pr-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                    </div>
                );
            case 'reset':
                return (
                    <>
                        <p className={`text-sm text-center ${mutedTextColor}`}>Um cÃ³digo foi enviado para <strong>{email}</strong>. Insira-o abaixo.</p>
                        <input type="text" placeholder="CÃ³digo de 6 dÃ­gitos" value={code} onChange={e => setCode(e.target.value)} required className={`w-full px-3 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors text-center tracking-[0.3em]`} />
                        <div className="relative">
                            <LockIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${mutedTextColor}`} />
                            <input type={isPasswordVisible ? 'text' : 'password'} placeholder="Nova Senha" value={password} onChange={e => setPassword(e.target.value)} required className={`w-full pl-10 pr-10 py-3 ${inputBg} border ${inputBorder} ${inputTextColor} rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors`} />
                            <button
                                type="button"
                                onClick={() => setIsPasswordVisible(!isPasswordVisible)}
                                className={`absolute right-3 top-1/2 -translate-y-1/2 ${mutedTextColor} hover:text-blue-400`}
                                aria-label={isPasswordVisible ? "Esconder senha" : "Mostrar senha"}
                            >
                                {isPasswordVisible ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                            </button>
                        </div>
                    </>
                );
        }
    };

    const getTitle = () => {
        switch (view) {
            case 'login': return 'Bem-vindo';
            case 'signup': return signupStep === 'name' ? 'Crie sua Conta' : 'Quase lÃ¡!';
            case 'forgot': return 'Recuperar Senha';
            case 'reset': return 'Redefinir Senha';
            case 'verify': return 'Verifique seu E-mail';
        }
    }

    const getButtonText = () => {
        switch (view) {
            case 'login': return 'Entrar';
            case 'signup': return signupStep === 'name' ? 'Avançar' : 'Cadastrar';
            case 'forgot': return 'Enviar Código de redefinição';
            case 'reset': return 'Redefinir Senha';
            case 'verify': return 'Verificar e Ativar Conta';
        }
    }

    return (
        <div className={`auth-container-bg h-screen w-screen flex flex-col justify-center items-center p-4 font-sans transition-colors`}>
            <div className="absolute top-4 right-4">
                <button
                    onClick={toggleTheme}
                    aria-label="Alternar tema"
                    className={`p-2 rounded-full transition-colors ${theme === 'dark' ? 'bg-slate-800 hover:bg-slate-700 text-gray-200' : 'bg-slate-200 hover:bg-slate-300 text-gray-700'}`}
                >
                    <ThemeToggleIcon theme={theme} />
                </button>
            </div>
            <div className={`w-full max-w-md ${cardBg} p-8 rounded-2xl`}>
                <div className="text-center mb-8">
                    <h1 className={`text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-400`}>
                        {getTitle()}
                    </h1>
                    <p className={`${mutedTextColor} mt-2`}>
                        {view === 'login' && 'Acesse sua conta para continuar.'}
                        {view === 'signup' && (signupStep === 'name' ? 'Primeiro, insira seu nome completo.' : 'Agora, seu e-mail e uma senha segura.')}
                        {view === 'verify' && 'O Ãºltimo passo para ativar sua conta.'}
                        {view === 'forgot' && 'Insira seu e-mail para receber o cÃ³digo.'}
                        {view === 'reset' && 'Crie uma nova senha para sua conta.'}
                    </p>
                </div>

                {error && <p className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 text-center">{error}</p>}
                {message && <p className="bg-green-900/50 text-green-300 text-sm p-3 rounded-lg mb-4 text-center">{message}</p>}

                <form onSubmit={handleSubmit} className="space-y-6">
                    {isLoading ? (
                        <div className="h-48 flex items-center justify-center">
                            <Spinner message="Processando..." />
                        </div>
                    ) : (
                        <>
                            {renderFormFields()}
                            <button type="submit" className="w-full bg-blue-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-500">
                                {getButtonText()}
                            </button>
                        </>
                    )}
                </form>
                <div className="mt-6 text-center text-sm">
                    {view === 'login' && (
                        <>
                            <p className={`${buttonTextColor}`}>
                                Não tem uma conta?{' '}
                                <button onClick={() => { setView('signup'); setError(null); setSignupStep('name'); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                    Cadastre-se
                                </button>
                            </p>
                            <p className={`${buttonTextColor} mt-2`}>
                                <button onClick={() => { setView('forgot'); setError(null); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                    Esqueceu a senha?
                                </button>
                            </p>
                        </>
                    )}
                    {view === 'signup' && (
                        <>
                            {signupStep === 'credentials' && (
                                <p className={`${buttonTextColor} mb-2`}>
                                    <button onClick={() => { setSignupStep('name'); setError(null); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                        Voltar
                                    </button>
                                </p>
                            )}
                            <p className={`${buttonTextColor}`}>
                                JÃ¡ tem uma conta?{' '}
                                <button onClick={() => { setView('login'); setError(null); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                    FaÃ§a login
                                </button>
                            </p>
                        </>
                    )}
                    {view === 'verify' && (
                        <>
                            <p className={`${buttonTextColor} mt-2`}>
                                Não recebeu o código?{' '}
                                <button onClick={handleResendVerification} className="font-semibold text-blue-400 hover:text-blue-300">
                                    Reenviar
                                </button>
                            </p>
                            <p className={`${buttonTextColor} mt-4`}>
                                <button onClick={() => { setView('login'); setError(null); setMessage(null); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                    Voltar para o login
                                </button>
                            </p>
                        </>
                    )}
                    {(view === 'forgot' || view === 'reset') && (
                        <p className={`${buttonTextColor} mt-4`}>
                            <button onClick={() => { setView('login'); setError(null); setMessage(null); }} className="font-semibold text-blue-400 hover:text-blue-300">
                                Voltar para o login
                            </button>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

// ==========================================================================
// MAIN APP COMPONENTS
// ==========================================================================

const Sidebar = ({ isCollapsed, onToggle, activeView, setActiveView, user, onLogout, theme, toggleTheme, photoUrl, onProfileClick, isMobileNavOpen, onCloseMobileNav, pendingApprovalsCount, pendingPurchasesCount }: { isCollapsed: boolean, onToggle: () => void, activeView: string, setActiveView: (view: string) => void, user: User, onLogout: () => void, theme: 'light' | 'dark', toggleTheme: () => void, photoUrl: string | null, onProfileClick: () => void, isMobileNavOpen: boolean, onCloseMobileNav: () => void, pendingApprovalsCount: number, pendingPurchasesCount: number }) => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const settingsRef = useRef<HTMLDivElement>(null);

    const allNavItems = [
        { id: 'formulario', label: 'Formulario', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" /></svg> },
        { id: 'setor_compras', label: 'Setor Compras', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c.51 0 .962-.343 1.087-.835l1.838-6.738a.75.75 0 0 0-.11-.646l-1.93-2.317a.75.75 0 0 0-.646-.353H6.25M7.5 14.25 5.106 5.106M15 7.5v3.75m-3.75-3.75v3.75M15 11.25H9" /></svg> },
        { id: 'aprovar_compras', label: 'Aprovar Compras', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg> },
        { id: 'dashboards', label: 'Dashboards', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" /></svg> },
    ];

    const role = user.role || 'user';
    const visibleNavItems = allNavItems.filter(item => {
        if (role === 'admin') return true;

        const rolePermissions: Record<string, string[]> = {
            'comprador': ['formulario', 'setor_compras'],
            'aprovador': ['formulario', 'aprovar_compras'],
            'user': ['formulario']
        };

        return rolePermissions[role]?.includes(item.id) ?? false;
    });

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
                setIsSettingsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleAdminClick = (e: React.MouseEvent) => {
        e.preventDefault();
        setActiveView('admin');
        setIsSettingsOpen(false);
        onCloseMobileNav();
    };

    const handleThemeClick = (e: React.MouseEvent) => {
        e.preventDefault();
        toggleTheme();
        setIsSettingsOpen(false);
    };

    const handleLogoutClick = (e: React.MouseEvent) => {
        e.preventDefault();
        onLogout();
        setIsSettingsOpen(false);
    };

    return (
        <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobileNavOpen ? 'mobile-open' : ''}`}>
            <div>
                <div className="sidebar-header">
                    <img src="https://iconecolegioecurso.com.br/wp-content/uploads/2022/08/xlogo_icone_site.png.pagespeed.ic_.QgXP3GszLC.webp" alt="Cantina Icone Logo" className="logo-img" />
                    <button className="mobile-sidebar-close" onClick={onCloseMobileNav} aria-label="Fechar menu">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <nav>
                    <ul className="nav-list">
                        {visibleNavItems.map(item => {
                            let badgeCount = 0;
                            if (item.id === 'aprovar_compras') {
                                badgeCount = pendingApprovalsCount;
                            }
                            if (item.id === 'setor_compras') {
                                badgeCount = pendingPurchasesCount;
                            }

                            return (
                                <li key={item.id} className={`nav-item ${activeView === item.id ? 'active' : ''}`}>
                                    <a href="#" onClick={(e) => { e.preventDefault(); setActiveView(item.id); onCloseMobileNav(); }}>
                                        {item.icon}
                                        <span>{item.label}</span>
                                        {badgeCount > 0 && <span className="nav-item-badge">{badgeCount}</span>}
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </nav>
            </div>
            <div className="sidebar-footer">
                <div className="sidebar-divider"></div>
                <button className="user-profile-button" onClick={onProfileClick}>
                    {photoUrl ? (
                        <img src={photoUrl} alt="Avatar" className="user-avatar" />
                    ) : (
                        <DefaultAvatar className="user-avatar" />
                    )}
                    <span className="user-name">{user.displayName.toUpperCase()}</span>
                </button>

                <div className="settings-menu-container" ref={settingsRef}>
                    {isSettingsOpen && (
                        <div className="settings-popup">
                            {user.role === 'admin' && (
                                <a href="#" className="sidebar-action" onClick={handleAdminClick}>
                                    <AdminIcon className="w-5 h-5" />
                                    <span>Admin</span>
                                </a>
                            )}
                            <a href="#" className="sidebar-action" onClick={handleThemeClick}>
                                {theme === 'dark' ? <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0z" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998z" /></svg>}
                                <span>Modo {theme === 'dark' ? 'Claro' : 'Escuro'}</span>
                            </a>
                            <a href="#" className="sidebar-action logout-btn" onClick={handleLogoutClick}>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" /></svg>
                                <span>Sair</span>
                            </a>
                        </div>
                    )}
                    <button className="sidebar-action" onClick={() => setIsSettingsOpen(prev => !prev)}>
                        <SettingsIcon className="w-5 h-5" />
                        <span>Configurações</span>
                    </button>
                </div>
            </div>
            <button className="sidebar-toggle" onClick={onToggle} aria-label="Toggle sidebar"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
        </aside>
    );
};

const initialFormData = {
    nome: '', email: '', unidade: '', prazo: 'nao', prazoDataHora: '', urgencia: '', tipo: '',
    descricaoServico: '', querIndicar: 'nao', nomeIndicado: '', nomeProduto: '', quantidadeProduto: '',
    querLink: 'nao', linkProduto: ''
};

const PurchaseForm = ({ user, onFormSubmit }: { user: User, onFormSubmit?: () => void }) => {
    const [formData, setFormData] = useState(initialFormData);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitStatus, setSubmitStatus] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    useEffect(() => {
        if (user) {
            setFormData(prev => ({
                ...prev,
                nome: user.displayName,
                email: user.email,
            }));
        }
    }, [user]);


    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData(prev => {
            const newState = { ...prev, [name]: value };
            if (name === 'tipo') {
                newState.descricaoServico = ''; newState.querIndicar = 'nao'; newState.nomeIndicado = '';
                newState.nomeProduto = ''; newState.quantidadeProduto = ''; newState.querLink = 'nao'; newState.linkProduto = '';
            }
            if (name === 'querIndicar' && value === 'nao') newState.nomeIndicado = '';
            if (name === 'querLink' && value === 'nao') newState.linkProduto = '';
            if (name === 'prazo' && value === 'nao') newState.prazoDataHora = '';
            return newState;
        });
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        const errors: string[] = [];
        if (!formData.unidade) errors.push('Unidade');
        if (!formData.urgencia) errors.push('Grau de urgência');
        if (!formData.tipo) errors.push('Tipo');

        if (formData.prazo === 'sim' && !formData.prazoDataHora) {
            errors.push('Data e Hora do Prazo');
        }

        if (formData.tipo === 'servico') {
            if (!formData.descricaoServico) errors.push('Descrição do serviço');
            if (formData.querIndicar === 'sim' && !formData.nomeIndicado) {
                errors.push('Nome de quem quer indicar');
            }
        }

        if (formData.tipo === 'produto') {
            if (!formData.nomeProduto) errors.push('Produto (nome)');
            if (!formData.quantidadeProduto) errors.push('Quantidade');
            if (formData.querLink === 'sim' && !formData.linkProduto) {
                errors.push('Link do produto');
            }
        }

        if (errors.length > 0) {
            setSubmitStatus({
                message: `Por favor, preencha os campos obrigatórios: ${errors.join(', ')}.`,
                type: 'error',
            });
            return;
        }

        setIsSubmitting(true);
        setSubmitStatus(null);

        const requestData = {
            ...formData,
            requesterUid: user.uid,
            createdAt: new Date().toISOString(),
            status: 'pendente',
        };

        try {
            const dbResponse = await databaseService.addPurchaseRequest(requestData);
            const newRequestId = dbResponse.name;

            // Envia o e-mail de notificaÃ§Ã£o e não espera pela resposta
            notificationService.sendPurchaseConfirmationEmail({
                ...requestData,
                id: newRequestId,
            });
            notificationService.notifyApproversAboutRequest({
                ...requestData,
                id: newRequestId,
            });

            setSubmitStatus({ message: 'Solicitação enviada com sucesso! Um e-mail de confirmação será enviado em breve.', type: 'success' });

            // Reseta os campos do formulario, exceto os dados do usuário
            const { nome, email, ...rest } = initialFormData;
            setFormData(prev => ({ ...prev, ...rest }));
            if (onFormSubmit) onFormSubmit();
        } catch (err: any) {
            setSubmitStatus({ message: err.message || 'Ocorreu um erro ao enviar a solicitação.', type: 'error' });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="form-container">
            <h1>Formulario de Compras</h1>
            <form onSubmit={handleSubmit} noValidate>
                {submitStatus && (
                    <div className={`p-3 rounded-lg mb-6 text-center text-sm ${submitStatus.type === 'success' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}`}>
                        {submitStatus.message}
                    </div>
                )}
                <div className="form-group">
                    <label htmlFor="nome">Nome</label>
                    <input type="text" id="nome" name="nome" className="input-field" value={formData.nome} onChange={handleChange} placeholder="Seu nome completo" required aria-required="true" disabled />
                </div>
                <div className="form-group">
                    <label htmlFor="email">E-mail</label>
                    <input type="email" id="email" name="email" className="input-field" value={formData.email} onChange={handleChange} placeholder="seuemail@exemplo.com" required aria-required="true" disabled />
                </div>
                <div className="form-group">
                    <label htmlFor="unidade">Selecione a unidade</label>
                    <select id="unidade" name="unidade" className="select-field" value={formData.unidade} onChange={handleChange} required aria-required="true">
                        <option value="" disabled>Escolha uma unidade</option>
                        {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={`Unidade ${n}`}>Unidade {n}</option>)}
                    </select>
                </div>
                <div className="form-group">
                    <fieldset>
                        <legend className="radio-group-label">Possui prazo?</legend>
                        <div className="radio-group">
                            <label className="radio-option"><input type="radio" name="prazo" value="sim" checked={formData.prazo === 'sim'} onChange={handleChange} /><span>Sim</span></label>
                            <label className="radio-option"><input type="radio" name="prazo" value="nao" checked={formData.prazo === 'nao'} onChange={handleChange} /><span>Não</span></label>
                        </div>
                    </fieldset>
                </div>
                {formData.prazo === 'sim' && (
                    <div className="form-group">
                        <label htmlFor="prazoDataHora">Data e Hora do Prazo</label>
                        <input type="datetime-local" id="prazoDataHora" name="prazoDataHora" className="input-field" value={formData.prazoDataHora} onChange={handleChange} required={formData.prazo === 'sim'} aria-required={formData.prazo === 'sim'} />
                    </div>
                )}
                <div className="form-group">
                    <label htmlFor="urgencia">Grau de urgência</label>
                    <select id="urgencia" name="urgencia" className="select-field" value={formData.urgencia} onChange={handleChange} required aria-required="true">
                        <option value="" disabled>Selecione o grau de urgência</option>
                        <option value="Baixo">Baixo</option>
                        <option value="Médio">Médio</option>
                        <option value="Alto">Alto</option>
                    </select>
                </div>
                <div className="form-group">
                    <label htmlFor="tipo">Tipo</label>
                    <select id="tipo" name="tipo" className="select-field" value={formData.tipo} onChange={handleChange} required aria-required="true">
                        <option value="" disabled>Selecione o tipo</option>
                        <option value="servico">Serviço</option>
                        <option value="produto">Produto</option>
                    </select>
                </div>
                {formData.tipo === 'servico' && (
                    <>
                        <div className="form-group"><label htmlFor="descricaoServico">Descrição do serviço</label><textarea id="descricaoServico" name="descricaoServico" className="input-field" value={formData.descricaoServico} onChange={handleChange} placeholder="Descreva o serviço..." rows={4} required={formData.tipo === 'servico'} aria-required={formData.tipo === 'servico'} /></div>
                        <div className="form-group"><fieldset><legend className="radio-group-label">Quer indicar alguém?</legend><div className="radio-group"><label className="radio-option"><input type="radio" name="querIndicar" value="sim" checked={formData.querIndicar === 'sim'} onChange={handleChange} /><span>Sim</span></label><label className="radio-option"><input type="radio" name="querIndicar" value="nao" checked={formData.querIndicar === 'nao'} onChange={handleChange} /><span>não</span></label></div></fieldset></div>
                        {formData.querIndicar === 'sim' && (<div className="form-group"><label htmlFor="nomeIndicado">Nome de quem quer indicar</label><input type="text" id="nomeIndicado" name="nomeIndicado" className="input-field" value={formData.nomeIndicado} onChange={handleChange} placeholder="Nome da pessoa indicada" required={formData.querIndicar === 'sim'} aria-required={formData.querIndicar === 'sim'} /></div>)}
                    </>
                )}
                {formData.tipo === 'produto' && (
                    <>
                        <div className="form-group"><label htmlFor="nomeProduto">Produto (nome)</label><input type="text" id="nomeProduto" name="nomeProduto" className="input-field" value={formData.nomeProduto} onChange={handleChange} placeholder="Nome do produto" required={formData.tipo === 'produto'} aria-required={formData.tipo === 'produto'} /></div>
                        <div className="form-group"><label htmlFor="quantidadeProduto">Quantidade</label><input type="number" id="quantidadeProduto" name="quantidadeProduto" className="input-field" value={formData.quantidadeProduto} onChange={handleChange} placeholder="1" min="1" required={formData.tipo === 'produto'} aria-required={formData.tipo === 'produto'} /></div>
                        <div className="form-group"><fieldset><legend className="radio-group-label">Quer colocar algum link?</legend><div className="radio-group"><label className="radio-option"><input type="radio" name="querLink" value="sim" checked={formData.querLink === 'sim'} onChange={handleChange} /><span>Sim</span></label><label className="radio-option"><input type="radio" name="querLink" value="nao" checked={formData.querLink === 'nao'} onChange={handleChange} /><span>Não</span></label></div></fieldset></div>
                        {formData.querLink === 'sim' && (<div className="form-group"><label htmlFor="linkProduto">Link do produto</label><input type="url" id="linkProduto" name="linkProduto" className="input-field" value={formData.linkProduto} onChange={handleChange} placeholder="https://exemplo.com/produto" required={formData.querLink === 'sim'} aria-required={formData.querLink === 'sim'} /></div>)}
                    </>
                )}
                <button type="submit" className="submit-btn" disabled={isSubmitting}>
                    {isSubmitting ? <Spinner size="small" /> : 'Enviar'}
                </button>
            </form>
        </div>
    );
}

interface PurchaseDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    request: any | null;
    theme: 'light' | 'dark';
}

const PurchaseDetailsModal: React.FC<PurchaseDetailsModalProps> = ({ isOpen, onClose, request, theme }) => {
    if (!isOpen || !request) return null;

    const modalBg = theme === 'dark' ? 'bg-slate-800 ring-1 ring-white/10' : 'bg-white';
    const titleColor = theme === 'dark' ? 'text-white' : 'text-slate-900';
    const labelColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
    const valueColor = theme === 'dark' ? 'text-gray-200' : 'text-slate-800';
    const dividerColor = theme === 'dark' ? 'border-slate-700' : 'border-slate-200';

    const DetailItem = ({ label, value }: { label: string, value: any }) => (
        value || value === 0 ? <div className='py-2'><p className={`text-sm font-medium ${labelColor}`}>{label}</p><p className={valueColor}>{value}</p></div> : null
    );

    const LinkItem = ({ label, value }: { label: string, value: any }) => (
        value ? <div className='py-2'><p className={`text-sm font-medium ${labelColor}`}>{label}</p><p className={valueColor}><a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{value}</a></p></div> : null
    );

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className={`${modalBg} rounded-2xl shadow-2xl w-full max-w-lg p-8 space-y-4`} onClick={e => e.stopPropagation()}>
                <h2 className={`text-2xl font-bold ${titleColor} mb-4 text-center`}>Detalhes da Solicitação</h2>
                <div className={`max-h-[60vh] overflow-y-auto pr-4 -mr-4 text-sm divide-y ${dividerColor}`}>
                    <DetailItem label="Solicitante" value={request.nome} />
                    <DetailItem label="E-mail" value={request.email} />
                    <DetailItem label="Unidade" value={request.unidade} />
                    <DetailItem label="Data da Solicitação" value={formatDate(request.createdAt, true)} />
                    <DetailItem label="Prazo" value={request.prazo === 'sim' ? formatDate(request.prazoDataHora, true) : 'Não possui'} />
                    <DetailItem label="UrgÃªncia" value={request.urgencia} />
                    <DetailItem label="Tipo" value={request.tipo} />
                    <DetailItem label="Status" value={<span className={`status-badge status-${request.status}`}>{request.status}</span>} />
                    {request.status === 'reprovado' && <DetailItem label="Justificativa" value={request.justification || 'Não informada'} />}
                    {request.tipo === 'servico' && (
                        <>
                            <DetailItem label="Descrição do Serviço" value={request.descricaoServico} />
                            <DetailItem label="Indicação" value={request.querIndicar === 'sim' ? request.nomeIndicado : 'Não'} />
                        </>
                    )}
                    {request.tipo === 'produto' && (
                        <>
                            <DetailItem label="Produto" value={request.nomeProduto} />
                            <DetailItem label="Quantidade" value={request.quantidadeProduto} />
                            <LinkItem label="Link" value={request.querLink === 'sim' ? request.linkProduto : null} />
                        </>
                    )}

                    {request.status === 'comprado' && (
                        <>
                            <DetailItem label="Valor Final" value={formatCurrency(request.valorProduto || request.valorServico)} />
                            {request.tipo === 'produto' && <DetailItem label="Previsão de Chegada" value={formatDate(request.previsaoChegada)} />}
                            {request.tipo === 'servico' && <DetailItem label="Data de Realização" value={formatDate(request.dataRealizacao)} />}
                            <LinkItem label="Cotação 1" value={request.linkCotacao1} />
                            <LinkItem label="Cotação 2" value={request.linkCotacao2} />
                            <LinkItem label="Cotação 3" value={request.linkCotacao3} />
                        </>
                    )}
                </div>
                <div className="flex justify-end pt-4">
                    <button onClick={onClose} className="px-6 py-2 rounded-lg text-white font-semibold bg-blue-600 hover:bg-blue-700 transition-colors">Fechar</button>
                </div>
            </div>
        </div>
    );
};

// ==========================================================================
// APROVAR COMPRAS PAGE
// ==========================================================================

const AprovarComprasPage = ({ theme, onStatusUpdate }: { theme: 'light' | 'dark', onStatusUpdate: () => void }) => {
    const [requests, setRequests] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isUpdating, setIsUpdating] = useState(false);
    const [activeTab, setActiveTab] = useState<'pendentes' | 'historico'>('pendentes');

    // State for modals
    const [selectedRequest, setSelectedRequest] = useState<any | null>(null); // For details modal
    const [requestToApprove, setRequestToApprove] = useState<any | null>(null);
    const [requestToReject, setRequestToReject] = useState<any | null>(null);

    useEffect(() => {
        const fetchRequests = async () => {
            try {
                const data = await databaseService.getPurchaseRequests();
                data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                setRequests(data);
            } catch (err: any) {
                setError(err.message || 'Erro ao buscar dados das compras.');
            } finally {
                setIsLoading(false);
            }
        };
        fetchRequests();
    }, []);

    const handleLocalStatusUpdate = (id: string, newStatus: 'aprovado' | 'reprovado', justification?: string) => {
        setRequests(prev => prev.map(req =>
            req.id === id ? { ...req, status: newStatus, justification } : req
        ));
    };

    const handleConfirmApproval = async () => {
        if (!requestToApprove) return;
        setIsUpdating(true);
        try {
            await databaseService.updatePurchaseRequestStatus(requestToApprove.id, 'aprovado');
            handleLocalStatusUpdate(requestToApprove.id, 'aprovado');
            notificationService.sendPurchaseStatusUpdateEmail(
                { ...requestToApprove },
                'aprovado'
            );
            onStatusUpdate();
        } catch (err) {
            setError('Falha ao aprovar a solicitação.');
        } finally {
            setIsUpdating(false);
            setRequestToApprove(null);
        }
    };

    const handleConfirmRejection = async (justification: string) => {
        if (!requestToReject) return;
        setIsUpdating(true);
        try {
            await databaseService.updatePurchaseRequestStatus(requestToReject.id, 'reprovado', justification);
            handleLocalStatusUpdate(requestToReject.id, 'reprovado', justification);
            notificationService.sendPurchaseStatusUpdateEmail(
                { ...requestToReject },
                'reprovado',
                justification
            );
            onStatusUpdate();
        } catch (err) {
            setError('Falha ao reprovar a solicitação.');
        } finally {
            setIsUpdating(false);
            setRequestToReject(null);
        }
    };

    const filteredRequests = requests.filter(req => {
        if (activeTab === 'pendentes') {
            return req.status === 'pendente';
        }
        if (activeTab === 'historico') {
            return req.status !== 'pendente';
        }
        return false;
    });


    if (isLoading) {
        return <div className="w-full flex justify-center items-start pt-16"><Spinner message="Carregando Solicitações..." /></div>;
    }

    if (error) {
        return <div className="text-red-400 text-center p-4">{error}</div>;
    }

    const ConfirmationModal = ({ isOpen, onClose, onConfirm, title, children, confirmText = 'Confirmar', cancelText = 'Cancelar' }: any) => {
        if (!isOpen) return null;
        const modalBg = theme === 'dark' ? 'bg-slate-800 ring-1 ring-white/10' : 'bg-white';
        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
                <div className={`${modalBg} rounded-2xl shadow-2xl w-full max-w-md p-8`} onClick={e => e.stopPropagation()}>
                    <h3 className="text-xl font-bold mb-4">{title}</h3>
                    <div className="text-gray-400 mb-6">{children}</div>
                    <div className="flex justify-end gap-4">
                        <button onClick={onClose} className="px-5 py-2 rounded-lg font-semibold bg-slate-600/50 hover:bg-slate-600/80 text-white transition-colors" disabled={isUpdating}>{cancelText}</button>
                        <button onClick={onConfirm} className="px-5 py-2 rounded-lg font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:bg-gray-500" disabled={isUpdating}>
                            {isUpdating ? <Spinner size="small" /> : confirmText}
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const RejectionModal = ({ isOpen, onClose, onConfirm }: any) => {
        const [justification, setJustification] = useState('');
        if (!isOpen) return null;

        const handleConfirm = () => {
            onConfirm(justification);
        };

        return (
            <ConfirmationModal
                isOpen={isOpen}
                onClose={onClose}
                onConfirm={handleConfirm}
                title="Reprovar solicitação"
                confirmText="Confirmar Reprovação"
            >
                <p>Por favor, forneÃ§a uma justificativa para a reprovação (opcional). Ela será visí­vel para o solicitante.</p>
                <textarea
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    className="rejection-modal-textarea mt-4"
                    placeholder="Ex: Item fora do orçamento, falta de detalhes, etc."
                    rows={4}
                    disabled={isUpdating}
                />
            </ConfirmationModal>
        );
    };


    return (
        <>
            <div className="table-container">
                <div className="page-header">
                    <h1>Aprovar Compras</h1>
                </div>
                <div className="tabs-container">
                    <button className={`tab-button ${activeTab === 'pendentes' ? 'active' : ''}`} onClick={() => setActiveTab('pendentes')}>
                        Pendentes
                    </button>
                    <button className={`tab-button ${activeTab === 'historico' ? 'active' : ''}`} onClick={() => setActiveTab('historico')}>
                        Histórico
                    </button>
                </div>
                <div className="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                <th>Unidade</th>
                                <th>Tipo</th>
                                <th>Prazo</th>
                                <th>URGÊNCIA</th>
                                <th>AÇÕES</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRequests.length > 0 ? (
                                filteredRequests.map(req => (
                                    <tr key={req.id}>
                                        <td>{req.unidade}</td>
                                        <td>{req.tipo}</td>
                                        <td>{req.prazo === 'sim' ? formatDate(req.prazoDataHora) : 'Não possui'}</td>
                                        <td>{req.urgencia}</td>
                                        <td>
                                            <div className="action-btn-group">
                                                <button
                                                    onClick={() => setSelectedRequest(req)}
                                                    className="details-btn icon-btn"
                                                    aria-label="Ver Detalhes"
                                                    title="Ver Detalhes"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                                    </svg>
                                                </button>
                                                {req.status === 'pendente' && (
                                                    <>
                                                        <button className="action-btn approve-btn" onClick={() => setRequestToApprove(req)}>Aprovar</button>
                                                        <button className="action-btn reject-btn" onClick={() => setRequestToReject(req)}>Reprovar</button>
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="text-center py-10 text-gray-400">
                                        Nenhuma solicitação para exibir nesta aba.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            <PurchaseDetailsModal
                isOpen={!!selectedRequest}
                onClose={() => setSelectedRequest(null)}
                request={selectedRequest}
                theme={theme}
            />
            <ConfirmationModal
                isOpen={!!requestToApprove}
                onClose={() => setRequestToApprove(null)}
                onConfirm={handleConfirmApproval}
                title="Aprovar Solicitação?"
                theme={theme}
                isUpdating={isUpdating}
            >
                <p>Você tem certeza que deseja aprovar esta solicitação de compra? Esta ação não pode ser desfeita.</p>
            </ConfirmationModal>
            <RejectionModal
                isOpen={!!requestToReject}
                onClose={() => setRequestToReject(null)}
                onConfirm={handleConfirmRejection}
                theme={theme}
                isUpdating={isUpdating}
            />
        </>
    );
};

// ==========================================================================
// SETOR COMPRAS PAGE
// ==========================================================================
interface PurchaseConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    request: any | null;
    onConfirm: (id: string, purchaseData: any) => Promise<void>;
    theme: 'light' | 'dark';
}

const PurchaseConfirmationModal: React.FC<PurchaseConfirmationModalProps> = ({ isOpen, onClose, request, onConfirm, theme }) => {
    const [purchaseData, setPurchaseData] = useState<any>({});
    const [isConfirming, setIsConfirming] = useState(false);

    useEffect(() => {
        if (request) {
            if (request.tipo === 'produto') {
                setPurchaseData({ valorProduto: '', linkCotacao1: '', linkCotacao2: '', linkCotacao3: '', previsaoChegada: '' });
            } else if (request.tipo === 'servico') {
                setPurchaseData({ valorServico: '', dataRealizacao: '' });
            }
        } else {
            setPurchaseData({});
        }
    }, [request]);

    if (!isOpen || !request) return null;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setPurchaseData((prev: any) => ({ ...prev, [name]: value }));
    };

    const handleCurrencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        const numericValue = value.replace(/\D/g, '');
        if (numericValue === '') {
            setPurchaseData(prev => ({ ...prev, [name]: '' }));
            return;
        }
        const number = parseFloat(numericValue) / 100;
        const formatted = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number);
        setPurchaseData(prev => ({ ...prev, [name]: formatted }));
    };


    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsConfirming(true);
        try {
            const dataToSubmit = { ...purchaseData };
            if (dataToSubmit.valorProduto) {
                dataToSubmit.valorProduto = parseFloat(dataToSubmit.valorProduto.replace('R$', '').trim().replace(/\./g, '').replace(',', '.'));
            }
            if (dataToSubmit.valorServico) {
                dataToSubmit.valorServico = parseFloat(dataToSubmit.valorServico.replace('R$', '').trim().replace(/\./g, '').replace(',', '.'));
            }
            await onConfirm(request.id, dataToSubmit);
            onClose();
        } catch (error) {
            console.error("Failed to confirm purchase:", error);
            alert("Falha ao confirmar a compra. Tente novamente.");
        } finally {
            setIsConfirming(false);
        }
    };

    const modalBg = theme === 'dark' ? 'bg-slate-800 ring-1 ring-white/10' : 'bg-white';
    const titleColor = theme === 'dark' ? 'text-white' : 'text-slate-900';

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className={`${modalBg} rounded-2xl shadow-2xl w-full max-w-lg p-8`} onClick={e => e.stopPropagation()}>
                <h2 className={`text-xl font-bold ${titleColor} mb-4`}>
                    Confirmar Compra: <span className="text-blue-400">{request.nomeProduto || request.descricaoServico}</span>
                </h2>
                <form onSubmit={handleSubmit}>
                    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-4 -mr-4">
                        {request.tipo === 'produto' && (
                            <>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="valorProduto" className="purchase-modal-label">Valor do Produto</label>
                                    <input type="text" id="valorProduto" name="valorProduto" value={purchaseData.valorProduto || ''} onChange={handleCurrencyChange} className="purchase-modal-input" placeholder="R$ 0,00" required />
                                </div>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="linkCotacao1" className="purchase-modal-label">Link de CotaÃ§Ã£o 1</label>
                                    <input type="url" id="linkCotacao1" name="linkCotacao1" value={purchaseData.linkCotacao1 || ''} onChange={handleChange} className="purchase-modal-input" placeholder="https://..." required />
                                </div>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="linkCotacao2" className="purchase-modal-label">Link de CotaÃ§Ã£o 2 (Opcional)</label>
                                    <input type="url" id="linkCotacao2" name="linkCotacao2" value={purchaseData.linkCotacao2 || ''} onChange={handleChange} className="purchase-modal-input" placeholder="https://..." />
                                </div>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="linkCotacao3" className="purchase-modal-label">Link de CotaÃ§Ã£o 3 (Opcional)</label>
                                    <input type="url" id="linkCotacao3" name="linkCotacao3" value={purchaseData.linkCotacao3 || ''} onChange={handleChange} className="purchase-modal-input" placeholder="https://..." />
                                </div>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="previsaoChegada" className="purchase-modal-label">PrevisÃ£o de Chegada</label>
                                    <input type="date" id="previsaoChegada" name="previsaoChegada" value={purchaseData.previsaoChegada || ''} onChange={handleChange} className="purchase-modal-input" required />
                                </div>
                            </>
                        )}
                        {request.tipo === 'servico' && (
                            <>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="valorServico" className="purchase-modal-label">Valor do Serviço</label>
                                    <input type="text" id="valorServico" name="valorServico" value={purchaseData.valorServico || ''} onChange={handleCurrencyChange} className="purchase-modal-input" placeholder="R$ 0,00" required />
                                </div>
                                <div className="purchase-modal-form-group">
                                    <label htmlFor="dataRealizacao" className="purchase-modal-label">Data de Realização</label>
                                    <input type="date" id="dataRealizacao" name="dataRealizacao" value={purchaseData.dataRealizacao || ''} onChange={handleChange} className="purchase-modal-input" required />
                                </div>
                            </>
                        )}
                    </div>
                    <div className="flex justify-end pt-6 gap-3">
                        <button type="button" onClick={onClose} className="px-5 py-2 rounded-lg font-semibold bg-slate-600/50 hover:bg-slate-600/80 text-white transition-colors">Cancelar</button>
                        <button type="submit" className="px-5 py-2 rounded-lg font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:bg-gray-500" disabled={isConfirming}>
                            {isConfirming ? <Spinner size="small" /> : 'Confirmar Compra'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};


const SetorComprasPage = ({ theme, onPurchaseConfirmed }: { theme: 'light' | 'dark', onPurchaseConfirmed: () => void }) => {
    const [requests, setRequests] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'pendentes' | 'historico'>('pendentes');

    const [selectedRequestForDetails, setSelectedRequestForDetails] = useState<any | null>(null);
    const [selectedRequestForPurchase, setSelectedRequestForPurchase] = useState<any | null>(null);

    const [uploadingId, setUploadingId] = useState<string | null>(null);
    const [viewingId, setViewingId] = useState<string | null>(null);
    const [currentRequestIdForUpload, setCurrentRequestIdForUpload] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);


    useEffect(() => {
        const fetchRequests = async () => {
            setIsLoading(true);
            try {
                const data = await databaseService.getPurchaseRequests();
                const relevantRequests = data
                    .filter((req: any) => req.status === 'aprovado' || req.status === 'comprado')
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                setRequests(relevantRequests);
            } catch (err: any) {
                setError(err.message || 'Erro ao buscar dados das compras.');
            } finally {
                setIsLoading(false);
            }
        };
        fetchRequests();
    }, []);

    const handleConfirmPurchase = async (id: string, purchaseData: any) => {
        try {
            await databaseService.confirmPurchase(id, purchaseData);
            setRequests(prev => prev.map(req =>
                req.id === id
                    ? { ...req, status: 'comprado', purchasedAt: new Date().toISOString(), ...purchaseData }
                    : req
            ));
            const confirmedRequest = requests.find(req => req.id === id);
            if (confirmedRequest) {
                notificationService.sendPurchaseTransitEmail(
                    { ...confirmedRequest, id },
                    purchaseData
                );
            }
            onPurchaseConfirmed();
        } catch (err) {
            setError('Falha ao confirmar a compra.');
            throw err;
        }
    };

    const handleUploadClick = (requestId: string) => {
        setCurrentRequestIdForUpload(requestId);
        fileInputRef.current?.click();
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !currentRequestIdForUpload) {
            return;
        }

        if (file.size > 5 * 1024 * 1024) { // 5MB limit
            alert('O arquivo e muito grande. O limite e de 5MB.');
            return;
        }

        setUploadingId(currentRequestIdForUpload);
        try {
            let invoicePayload: { pages: string[]; mimeType: string; originalName?: string };

            if (file.type === 'application/pdf') {
                const compressedImages = await compressPdfToJpegArray(
                    file,
                    PDF_COMPRESSION_CONFIG.scale,
                    PDF_COMPRESSION_CONFIG.quality
                );
                if (!compressedImages || compressedImages.length === 0) {
                    throw new Error('Falha ao processar o arquivo PDF.');
                }
                invoicePayload = {
                    pages: compressedImages,
                    mimeType: 'image/jpeg',
                    originalName: file.name
                };
            } else {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = loadEvent => resolve(loadEvent.target?.result as string);
                    reader.onerror = error => reject(error);
                    reader.readAsDataURL(file);
                });
                const base64 = dataUrl.split(',')[1];
                if (!base64) {
                    throw new Error('Erro ao processar o arquivo selecionado.');
                }
                invoicePayload = {
                    pages: [base64],
                    mimeType: file.type || 'image/jpeg',
                    originalName: file.name
                };
            }

            await databaseService.uploadAndLinkInvoice(currentRequestIdForUpload, invoicePayload);

            setRequests(prev => prev.map(req =>
                req.id === currentRequestIdForUpload ? { ...req, hasInvoice: true, invoicePagesCount: invoicePayload.pages.length } : req
            ));

        } catch (err: any) {
            console.error(err);
            alert(`Falha no upload: ${err.message}`);
        } finally {
            setUploadingId(null);
            setCurrentRequestIdForUpload(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const handleViewInvoice = async (requestId: string) => {
        setViewingId(requestId);
        const previewWindow = window.open('', '_blank');
        if (!previewWindow) {
            alert('Permita pop-ups para visualizar a nota fiscal.');
            setViewingId(null);
            return;
        }
        previewWindow.document.write('<p style="font-family: system-ui; padding: 16px;">Carregando nota fiscal...</p>');
        try {
            const { pages, mimeType } = await databaseService.getInvoice(requestId);
            if (!pages || pages.length === 0) {
                throw new Error('Nota fiscal sem paginas para exibir.');
            }
            const htmlPages = pages.map((page, index) => `
                <div class="page">
                    <div class="page-label">Pagina ${index + 1}</div>
                    <img src="data:${mimeType};base64,${page}" alt="Pagina ${index + 1}" />
                </div>
            `).join('');
            previewWindow.document.open();
            previewWindow.document.write(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="utf-8" />
                    <title>Nota Fiscal</title>
                    <style>
                        body { margin: 0; background: #0f172a; color: #e2e8f0; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                        .container { padding: 24px; }
                        .page { max-width: 900px; margin: 0 auto 32px auto; background: #1e293b; padding: 16px; border-radius: 12px; box-shadow: 0 10px 30px rgba(15,23,42,0.4); }
                        .page-label { margin-bottom: 8px; font-weight: 600; }
                        img { width: 100%; height: auto; border-radius: 8px; background: #fff; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        ${htmlPages}
                    </div>
                </body>
                </html>
            `);
            previewWindow.document.close();
        } catch (err: any) {
            console.error(err);
            previewWindow.close();
            alert(`Falha ao buscar nota fiscal: ${err.message}`);
        } finally {
            setViewingId(null);
        }
    };

    const filteredRequests = requests.filter(req => {
        if (activeTab === 'pendentes') {
            return req.status === 'aprovado';
        }
        if (activeTab === 'historico') {
            return req.status === 'comprado';
        }
        return false;
    });

    if (isLoading) {
        return <div className="w-full flex justify-center items-start pt-16"><Spinner message="Carregando solicitaÃ§Ãµes..." /></div>;
    }

    if (error) {
        return <div className="text-red-400 text-center p-4">{error}</div>;
    }

    return (
        <>
            <div className="table-container">
                <div className="page-header">
                    <h1>Setor de Compras</h1>
                </div>
                <div className="tabs-container">
                    <button className={`tab-button ${activeTab === 'pendentes' ? 'active' : ''}`} onClick={() => setActiveTab('pendentes')}>
                        Pendentes
                    </button>
                    <button className={`tab-button ${activeTab === 'historico' ? 'active' : ''}`} onClick={() => setActiveTab('historico')}>
                        Histórico
                    </button>
                </div>
                {filteredRequests.length === 0 ? (
                    <div className="text-center py-10">
                        <p className="text-gray-400">Nenhuma solicitação para exibir nesta aba.</p>
                    </div>
                ) : (
                    <div className="table-wrapper">
                        <table>
                            <thead>
                                {activeTab === 'pendentes' ? (
                                    <tr>
                                        <th>Unidade</th>
                                        <th>Solicitante</th>
                                        <th>Item</th>
                                        <th>Tipo</th>
                                        <th>Prazo</th>
                                        <th>Urgência</th>
                                        <th>AÇÕES</th>
                                    </tr>
                                ) : (
                                    <tr>
                                        <th>Unidade</th>
                                        <th>Solicitante</th>
                                        <th>Item</th>
                                        <th>Tipo</th>
                                        <th>Valor Final</th>
                                        <th>Data da Compra</th>
                                        <th>Nota Fiscal</th>
                                        <th>AÃ§Ãµes</th>
                                    </tr>
                                )}
                            </thead>
                            <tbody>
                                {filteredRequests.map(req => (
                                    <tr key={req.id}>
                                        <td>{req.unidade}</td>
                                        <td>{req.nome}</td>
                                        <td>{req.nomeProduto || req.descricaoServico}</td>
                                        <td>{req.tipo}</td>
                                        {activeTab === 'pendentes' ? (
                                            <>
                                                <td>{req.prazo === 'sim' ? formatDate(req.prazoDataHora) : 'Não possui'}</td>
                                                <td>{req.urgencia}</td>
                                            </>
                                        ) : (
                                            <>
                                                <td>{formatCurrency(req.valorProduto || req.valorServico)}</td>
                                                <td>{formatDate(req.purchasedAt)}</td>
                                                <td>
                                                    {uploadingId === req.id ? (
                                                        <div className="flex justify-center"><Spinner size="small" /></div>
                                                    ) : req.hasInvoice ? (
                                                        <button
                                                            className="action-btn comprar-btn"
                                                            onClick={() => handleViewInvoice(req.id)}
                                                            disabled={viewingId === req.id}
                                                            style={{ minWidth: '100px' }}
                                                        >
                                                            {viewingId === req.id ? <Spinner size="small" /> : 'Visualizar'}
                                                        </button>
                                                    ) : (
                                                        <button
                                                            className="details-btn icon-btn"
                                                            title="Anexar Nota Fiscal"
                                                            onClick={() => handleUploadClick(req.id)}
                                                        >
                                                            <UploadIcon className="w-5 h-5" />
                                                        </button>
                                                    )}
                                                </td>
                                            </>
                                        )}
                                        <td>
                                            <div className="action-btn-group">
                                                <button
                                                    onClick={() => setSelectedRequestForDetails(req)}
                                                    className="details-btn icon-btn"
                                                    aria-label="Ver Detalhes"
                                                    title="Ver Detalhes"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                                    </svg>
                                                </button>
                                                {activeTab === 'historico' && (
                                                    <button
                                                        onClick={() => handleUploadClick(req.id)}
                                                        className="details-btn icon-btn"
                                                        aria-label={req.hasInvoice ? 'Atualizar nota fiscal' : 'Enviar nota fiscal'}
                                                        title={req.hasInvoice ? 'Atualizar Nota Fiscal' : 'Enviar Nota Fiscal'}
                                                        disabled={uploadingId === req.id}
                                                    >
                                                        {uploadingId === req.id ? <Spinner size="small" /> : <UploadIcon className="w-5 h-5" />}
                                                    </button>
                                                )}
                                                {activeTab === 'pendentes' && (
                                                    <button
                                                        onClick={() => setSelectedRequestForPurchase(req)}
                                                        className="action-btn comprar-btn"
                                                    >
                                                        Comprar
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                style={{ display: 'none' }}
                accept="image/jpeg,image/png,application/pdf"
            />
            <PurchaseDetailsModal
                isOpen={!!selectedRequestForDetails}
                onClose={() => setSelectedRequestForDetails(null)}
                request={selectedRequestForDetails}
                theme={theme}
            />

            <PurchaseConfirmationModal
                isOpen={!!selectedRequestForPurchase}
                onClose={() => setSelectedRequestForPurchase(null)}
                request={selectedRequestForPurchase}
                onConfirm={handleConfirmPurchase}
                theme={theme}
            />
        </>
    );
};

// ==========================================================================
// DASHBOARDS PAGE
// ==========================================================================
interface KpiCardProps {
    title: string;
    value: string | number;
    icon: React.ReactNode;
    theme: 'light' | 'dark';
    onClick?: () => void;
    colSpan?: number;
}

const KpiCard: React.FC<KpiCardProps> = ({ title, value, icon, theme, onClick, colSpan }) => {
    const cardBg = theme === 'dark' ? 'bg-slate-800' : 'bg-white';
    const iconBg = theme === 'dark' ? 'bg-slate-700' : 'bg-slate-100';
    const iconColor = theme === 'dark' ? 'text-blue-400' : 'text-blue-600';
    const titleColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-600';
    const valueColor = theme === 'dark' ? 'text-white' : 'text-slate-900';
    const interactiveClasses = onClick ? 'cursor-pointer transition-transform duration-200 hover:scale-[1.03]' : '';
    const spanClass = colSpan && colSpan > 1 ? `kpi-card-span-${colSpan}` : '';
    const classes = ['kpi-card', cardBg, interactiveClasses, spanClass].filter(Boolean).join(' ');

    return (
        <div className={classes} onClick={onClick}>
            <div className={`kpi-card-icon-wrapper ${iconBg}`}>
                <div className={`${iconColor}`}>
                    {icon}
                </div>
            </div>
            <div className="kpi-card-content">
                <p className={`kpi-card-title ${titleColor}`}>{title}</p>
                <p className={`kpi-card-value ${valueColor}`}>{value}</p>
            </div>
        </div>
    );
};

interface ColumnChartProps {
    data: { name: string; value: number }[];
    theme: 'light' | 'dark';
    onBarClick?: (barName: string) => void;
}

const ColumnChart: React.FC<ColumnChartProps> = ({ data, theme, onBarClick }) => {
    const [tooltip, setTooltip] = useState<{ content: string; x: number; y: number; visible: boolean } | null>(null);
    const chartRef = useRef<HTMLDivElement>(null);

    if (!data || data.length === 0) {
        return (
            <div className="chart-card">
                <h3 className="chart-title">Valor Gasto por Unidade</h3>
                <div className="flex items-center justify-center h-64 text-gray-400">
                    Nenhum dado de compra concluÃ­da para exibir.
                </div>
            </div>
        );
    }

    const getNiceMaxValue = (maxValue: number) => {
        if (maxValue === 0) return 1;
        const exponent = Math.floor(Math.log10(maxValue));
        const powerOf10 = 10 ** exponent;
        const rounded = Math.ceil(maxValue / powerOf10) * powerOf10;
        return rounded;
    };

    const maxValue = Math.max(...data.map(d => d.value), 0);
    const yAxisMax = getNiceMaxValue(maxValue);
    const yAxisTicks = [0, yAxisMax * 0.25, yAxisMax * 0.5, yAxisMax * 0.75, yAxisMax];

    const handleMouseOver = (e: React.MouseEvent, item: { name: string; value: number }) => {
        const bar = e.currentTarget as HTMLDivElement;
        const rect = bar.getBoundingClientRect();
        const chartRect = chartRef.current?.getBoundingClientRect();

        if (chartRect) {
            setTooltip({
                content: `${item.name}: ${formatCurrency(item.value)}`,
                x: rect.left + rect.width / 2 - chartRect.left,
                y: rect.top - chartRect.top,
                visible: true,
            });
        }
    };

    const handleMouseLeave = () => {
        setTooltip(prev => prev ? { ...prev, visible: false } : null);
    };

    const cardBg = theme === 'dark' ? 'bg-slate-800' : 'bg-white';

    return (
        <div className={`chart-card ${cardBg}`}>
            <h3 className="chart-title">Valor Gasto por Unidade</h3>
            {tooltip && (
                <div
                    className="chart-tooltip"
                    style={{
                        left: `${tooltip.x}px`,
                        top: `${tooltip.y}px`,
                        opacity: tooltip.visible ? 1 : 0,
                    }}
                >
                    {tooltip.content}
                </div>
            )}
            <div className="chart-container" ref={chartRef}>
                <div className="chart-y-axis">
                    {yAxisTicks.slice().reverse().map((tick, index) => (
                        <div key={index} className="chart-y-label">
                            {formatCurrency(tick).replace(/\,00$/, '')}
                        </div>
                    ))}
                </div>
                <div className="chart-main">
                    <div className="chart-grid-lines">
                        {yAxisTicks.slice(1).map((_, index) => (
                            <div key={index} className="chart-grid-line"></div>
                        ))}
                    </div>
                    {data.map((item, index) => (
                        <div key={index} className="chart-bar-wrapper">
                            <div
                                className="chart-bar"
                                style={{
                                    height: `${yAxisMax > 0 ? (item.value / yAxisMax) * 100 : 0}%`,
                                    cursor: onBarClick ? 'pointer' : 'default',
                                }}
                                onMouseOver={(e) => handleMouseOver(e, item)}
                                onMouseLeave={handleMouseLeave}
                                onClick={() => onBarClick && onBarClick(item.name)}
                            ></div>
                        </div>
                    ))}
                </div>
                <div className="chart-x-axis">
                    {data.map((item, index) => (
                        <div key={index} className="chart-label" title={item.name}>
                            {item.name}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const DashboardsPage = ({ theme }: { theme: 'light' | 'dark' }) => {
    const [stats, setStats] = useState({
        totalSpent: 0,
        totalRequests: 0,
        completedPurchases: 0,
        rejectedRequests: 0,
    });
    const [chartData, setChartData] = useState<{ name: string; value: number }[]>([]);
    const [allRequests, setAllRequests] = useState<any[]>([]);
    const [modalInfo, setModalInfo] = useState<{ title: string; requests: any[] } | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchAndCalculateStats = async () => {
            setIsLoading(true);
            try {
                const data = await databaseService.getPurchaseRequests();
                setAllRequests(data);
                if (!data) {
                    setIsLoading(false);
                    return;
                }

                const spendingByUnit: { [key: string]: number } = {
                    'Unidade 1': 0, 'Unidade 2': 0, 'Unidade 3': 0,
                    'Unidade 4': 0, 'Unidade 5': 0, 'Unidade 6': 0,
                };
                let unassignedSpending = 0;
                let totalSpent = 0;
                let completedPurchases = 0;
                let rejectedRequests = 0;

                data.forEach(req => {
                    if (req.status === 'comprado') {
                        completedPurchases++;
                        const value = req.valorProduto || req.valorServico;
                        if (value) {
                            const cleanedValue = String(value).replace(/[^\d,.-]+/g, '').replace(/\./g, '').replace(',', '.');
                            const numericValue = parseFloat(cleanedValue);
                            if (!isNaN(numericValue)) {
                                totalSpent += numericValue;
                                const unitName = req.unidade;
                                if (unitName && spendingByUnit.hasOwnProperty(unitName)) {
                                    spendingByUnit[unitName] += numericValue;
                                } else {
                                    unassignedSpending += numericValue;
                                }
                            }
                        }
                    }
                    if (req.status === 'reprovado') {
                        rejectedRequests++;
                    }
                });

                const totalRequests = data.length;

                setStats({
                    totalSpent,
                    totalRequests,
                    completedPurchases,
                    rejectedRequests,
                });

                const formattedChartData = Object.keys(spendingByUnit)
                    .map(unitName => ({
                        name: unitName,
                        value: spendingByUnit[unitName]
                    }));

                if (unassignedSpending > 0) {
                    formattedChartData.push({ name: 'Não Informada', value: unassignedSpending });
                }

                setChartData(formattedChartData);

            } catch (err: any) {
                setError(err.message || 'Erro ao calcular as Métricas.');
            } finally {
                setIsLoading(false);
            }
        };

        fetchAndCalculateStats();
    }, []);

    const handleKpiClick = (kpi: 'totalSpent' | 'totalRequests' | 'completed' | 'rejected') => {
        let title = '';
        let filteredRequests: any[] = [];

        switch (kpi) {
            case 'totalSpent':
                title = 'Detalhes: Valor Total Gasto';
                filteredRequests = allRequests.filter(r => r.status === 'comprado' && (r.valorProduto || r.valorServico));
                break;
            case 'totalRequests':
                title = 'Detalhes: Total de Solicitações';
                filteredRequests = allRequests;
                break;
            case 'completed':
                title = 'Detalhes: Compras Concluidas';
                filteredRequests = allRequests.filter(r => r.status === 'comprado');
                break;
            case 'rejected':
                title = 'Detalhes: Solicitações Reprovadas';
                filteredRequests = allRequests.filter(r => r.status === 'reprovado');
                break;
            default:
                return;
        }

        filteredRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setModalInfo({ title, requests: filteredRequests });
    };

    const handleBarClick = (unitName: string) => {
        const title = `Detalhes: Gastos da ${unitName}`;
        let filteredRequests: any[];

        const validUnits = ['Unidade 1', 'Unidade 2', 'Unidade 3', 'Unidade 4', 'Unidade 5', 'Unidade 6'];

        if (unitName === 'Não Informada') {
            filteredRequests = allRequests.filter(r =>
                r.status === 'comprado' &&
                (r.valorProduto || r.valorServico) &&
                (!r.unidade || !validUnits.includes(r.unidade))
            );
        } else {
            filteredRequests = allRequests.filter(r =>
                r.status === 'comprado' &&
                r.unidade === unitName &&
                (r.valorProduto || r.valorServico)
            );
        }

        filteredRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setModalInfo({ title, requests: filteredRequests });
    };

    if (isLoading) {
        return <div className="w-full flex justify-center items-start pt-16"><Spinner message="Calculando Métricas..." /></div>;
    }

    if (error) {
        return <div className="text-red-400 text-center p-4">{error}</div>;
    }

    return (
        <div className="table-container">
            <div className="page-header">
                <h1>Dashboards</h1>
            </div>
            <div className="kpi-grid">
                <KpiCard
                    title="Valor Total Gasto"
                    value={formatCurrency(stats.totalSpent)}
                    icon={<DollarSignIcon className="w-8 h-8" />}
                    theme={theme}
                    onClick={() => handleKpiClick('totalSpent')}
                    colSpan={2}
                />
                <KpiCard
                    title="Total de Solicitações"
                    value={stats.totalRequests}
                    icon={<ClipboardListIcon className="w-8 h-8" />}
                    theme={theme}
                    onClick={() => handleKpiClick('totalRequests')}
                />
                <KpiCard
                    title="Compras Concluídas"
                    value={stats.completedPurchases}
                    icon={<CheckCircleIcon className="w-8 h-8" />}
                    theme={theme}
                    onClick={() => handleKpiClick('completed')}
                />
                <KpiCard
                    title="Solicitações Reprovadas"
                    value={stats.rejectedRequests}
                    icon={<XCircleIcon className="w-8 h-8" />}
                    theme={theme}
                    onClick={() => handleKpiClick('rejected')}
                />
            </div>
            <div className="mt-8">
                <ColumnChart data={chartData} theme={theme} onBarClick={handleBarClick} />
            </div>

            <KpiDetailsModal
                isOpen={!!modalInfo}
                onClose={() => setModalInfo(null)}
                title={modalInfo?.title || ''}
                requests={modalInfo?.requests || []}
                theme={theme}
            />
        </div>
    );
};

// ==========================================================================
// KPI DETAILS MODAL
// ==========================================================================
interface KpiDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    requests: any[];
    theme: 'light' | 'dark';
}

const KpiDetailsModal: React.FC<KpiDetailsModalProps> = ({ isOpen, onClose, title, requests, theme }) => {
    if (!isOpen) return null;

    const modalBg = theme === 'dark' ? 'bg-slate-800 ring-1 ring-white/10' : 'bg-white';
    const titleColor = theme === 'dark' ? 'text-white' : 'text-slate-900';
    const dividerColor = theme === 'dark' ? 'border-slate-700' : 'border-slate-200';

    const getDateForRequest = (req: any) => {
        if (req.status === 'comprado' && req.purchasedAt) return formatDate(req.purchasedAt);
        if (req.status === 'aprovado' && req.approvedAt) return formatDate(req.approvedAt);
        if (req.status === 'reprovado' && req.rejectedAt) return formatDate(req.rejectedAt);
        return formatDate(req.createdAt);
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className={`${modalBg} rounded-2xl shadow-2xl w-full max-w-4xl p-8 flex flex-col`} onClick={e => e.stopPropagation()}>
                <h2 className={`text-2xl font-bold ${titleColor} mb-6 text-center`}>{title}</h2>
                <div className="flex-grow overflow-y-auto" style={{ maxHeight: '60vh' }}>
                    {requests.length > 0 ? (
                        <div className="table-wrapper">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Solicitante</th>
                                        <th>Item</th>
                                        <th>Unidade</th>
                                        <th>Data</th>
                                        <th>Status</th>
                                        <th>Valor</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {requests.map(req => (
                                        <tr key={req.id}>
                                            <td>{req.nome}</td>
                                            <td>{req.nomeProduto || req.descricaoServico || 'N/A'}</td>
                                            <td>{req.unidade || 'N/A'}</td>
                                            <td>{getDateForRequest(req)}</td>
                                            <td><span className={`status-badge status-${req.status}`}>{req.status}</span></td>
                                            <td>{formatCurrency(req.valorProduto || req.valorServico)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="text-center text-gray-400 py-10">Nenhum dado para exibir.</p>
                    )}
                </div>
                <div className="flex justify-end pt-6 mt-2 border-t" style={{ borderColor: dividerColor }}>
                    <button onClick={onClose} className="px-6 py-2 rounded-lg text-white font-semibold bg-blue-600 hover:bg-blue-700 transition-colors">Fechar</button>
                </div>
            </div>
        </div>
    );
};

// ==========================================================================
// ADMIN & PROFILE & APP COMPONENTS
// ==========================================================================

const AdminPage = ({ theme }: { theme: 'light' | 'dark' }) => {
    const [users, setUsers] = useState<(User & { photoUrl: string | null })[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchUsers = async () => {
        setIsLoading(true);
        try {
            const userList = await authService.getAllUsers();
            setUsers(userList);
        } catch (err: any) {
            setError(err.message || 'Falha ao carregar usuários.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchUsers();
    }, []);

    const handleRoleChange = async (uid: string, newRole: User['role']) => {
        try {
            await authService.updateUserRole(uid, newRole);
            setUsers(users.map(u => u.uid === uid ? { ...u, role: newRole } : u));
        } catch (error) {
            alert('Falha ao atualizar a permissão do usuário.');
        }
    };

    if (isLoading) return <div className="w-full flex justify-center items-start pt-16"><Spinner message="Carregando usuários..." /></div>;
    if (error) return <div className="text-red-400 text-center p-4">{error}</div>;

    return (
        <div className="table-container">
            <div className="page-header"><h1>Painel Administrativo</h1></div>
            <div className="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Usuário</th>
                            <th>E-mail</th>
                            <th>Permissão</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(user => (
                            <tr key={user.uid}>
                                <td>
                                    <div className="flex items-center gap-3">
                                        {user.photoUrl ? <img src={user.photoUrl} alt="Avatar" className="w-8 h-8 rounded-full object-cover" /> : <DefaultAvatar className="w-8 h-8 rounded-full" />}
                                        <span className="font-medium">{user.displayName}</span>
                                    </div>
                                </td>
                                <td>{user.email}</td>
                                <td>
                                    <select
                                        value={user.role}
                                        onChange={(e) => handleRoleChange(user.uid, e.target.value as User['role'])}
                                        className="select-field text-sm"
                                    >
                                        <option value="user">Usuário</option>
                                        <option value="comprador">Comprador</option>
                                        <option value="aprovador">Aprovador</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const ProfileModal = ({ user, isOpen, onClose, onProfileUpdate, theme, currentPhotoUrl }: { user: User, isOpen: boolean, onClose: () => void, onProfileUpdate: (updatedUser: { displayName: string, photoUrl: string | null }) => void, theme: 'light' | 'dark', currentPhotoUrl: string | null }) => {
    const [displayName, setDisplayName] = useState(user.displayName);
    const [photo, setPhoto] = useState<string | null>(currentPhotoUrl);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDisplayName(user.displayName);
        setPhoto(currentPhotoUrl);
    }, [user, currentPhotoUrl]);

    const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setPhoto(reader.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            await authService.updateUserProfile({ uid: user.uid, displayName, photoBase64: photo });
            onProfileUpdate({ displayName, photoUrl: photo });
            onClose();
        } catch (error: any) {
            alert('Falha ao atualizar o perfil: ' + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isOpen) return null;
    const modalBg = theme === 'dark' ? 'bg-slate-800' : 'bg-white';

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className={`${modalBg} rounded-2xl shadow-2xl w-full max-w-md p-8`} onClick={e => e.stopPropagation()}>
                <h2 className="text-2xl font-bold mb-6 text-center">Editar Perfil</h2>
                <form onSubmit={handleSubmit}>
                    <div className="flex flex-col items-center mb-6">
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="relative group">
                            {photo ? <img src={photo} alt="Avatar" className="w-24 h-24 rounded-full object-cover" /> : <DefaultAvatar className="w-24 h-24 rounded-full" />}
                            <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 flex items-center justify-center rounded-full transition-all">
                                <span className="text-white text-xs opacity-0 group-hover:opacity-100">Trocar foto</span>
                            </div>
                        </button>
                        <input type="file" ref={fileInputRef} onChange={handlePhotoChange} accept="image/*" className="hidden" />
                    </div>
                    <div className="form-group">
                        <label htmlFor="displayName">Nome Completo</label>
                        <input type="text" id="displayName" value={displayName} onChange={e => setDisplayName(e.target.value)} className="input-field" />
                    </div>
                    <div className="flex justify-end gap-4 mt-8">
                        <button type="button" onClick={onClose} className="px-6 py-2 rounded-lg font-semibold bg-slate-600/50 hover:bg-slate-600/80 text-white transition-colors">Cancelar</button>
                        <button type="submit" className="px-6 py-2 rounded-lg font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:bg-gray-500" disabled={isSubmitting}>
                            {isSubmitting ? <Spinner size="small" /> : 'Salvar'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};


const App: React.FC<{ user: User; onLogout: () => void; theme: 'light' | 'dark'; toggleTheme: () => void }> = ({ user, onLogout, theme, toggleTheme }) => {
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [activeView, setActiveView] = useState('formulario');
    const [currentUser, setCurrentUser] = useState(user);
    const [photoUrl, setPhotoUrl] = useState<string | null>(null);
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
    const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);
    const [pendingPurchasesCount, setPendingPurchasesCount] = useState(0);

    const fetchCounts = async () => {
        try {
            const requests = await databaseService.getPurchaseRequests();
            if (requests) {
                const approvals = requests.filter(r => r.status === 'pendente').length;
                const purchases = requests.filter(r => r.status === 'aprovado').length;
                setPendingApprovalsCount(approvals);
                setPendingPurchasesCount(purchases);
            }
        } catch (error) {
            console.error("Failed to fetch counts for sidebar badges:", error);
        }
    };

    useEffect(() => {
        fetchCounts();
        authService.getUserProfilePhoto(user.uid).then(setPhotoUrl);
    }, [user.uid]);

    useEffect(() => {
        const role = user.role || 'user';
        const rolePermissions: Record<string, string[]> = {
            'comprador': ['formulario', 'setor_compras'],
            'aprovador': ['formulario', 'aprovar_compras'],
            'user': ['formulario'],
            'admin': ['formulario', 'setor_compras', 'aprovar_compras', 'dashboards', 'admin']
        };
        const defaultView = (rolePermissions[role] || ['formulario'])[0];
        setActiveView(defaultView);
    }, [user.role]);

    const handleProfileUpdate = (updatedUser: { displayName: string, photoUrl: string | null }) => {
        setCurrentUser(prev => ({ ...prev, displayName: updatedUser.displayName }));
        setPhotoUrl(updatedUser.photoUrl);
    };

    const handleSetActiveView = (view: string) => {
        setActiveView(view);
        setIsMobileNavOpen(false);
    };

    const handleProfileClick = () => {
        setIsProfileModalOpen(true);
        setIsMobileNavOpen(false);
    };

    const renderContent = () => {
        switch (activeView) {
            case 'formulario':
                return <PurchaseForm user={currentUser} onFormSubmit={fetchCounts} />;
            case 'setor_compras':
                return <SetorComprasPage theme={theme} onPurchaseConfirmed={fetchCounts} />;
            case 'aprovar_compras':
                return <AprovarComprasPage theme={theme} onStatusUpdate={fetchCounts} />;
            case 'dashboards':
                return <DashboardsPage theme={theme} />;
            case 'admin':
                return <AdminPage theme={theme} />;
            default:
                return <PurchaseForm user={currentUser} onFormSubmit={fetchCounts} />;
        }
    };

    return (
        <div className="app-layout">
            <Sidebar
                isCollapsed={isCollapsed}
                onToggle={() => setIsCollapsed(!isCollapsed)}
                activeView={activeView}
                setActiveView={handleSetActiveView}
                user={currentUser}
                onLogout={onLogout}
                theme={theme}
                toggleTheme={toggleTheme}
                photoUrl={photoUrl}
                onProfileClick={handleProfileClick}
                isMobileNavOpen={isMobileNavOpen}
                onCloseMobileNav={() => setIsMobileNavOpen(false)}
                pendingApprovalsCount={pendingApprovalsCount}
                pendingPurchasesCount={pendingPurchasesCount}
            />
            <main className="main-content">
                <header className="main-header">
                    <button className="mobile-nav-toggle" onClick={() => setIsMobileNavOpen(true)} aria-label="Abrir menu">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                        </svg>
                    </button>
                </header>
                {renderContent()}
            </main>
            {isMobileNavOpen && <div className="mobile-nav-overlay" onClick={() => setIsMobileNavOpen(false)}></div>}
            <ProfileModal
                isOpen={isProfileModalOpen}
                onClose={() => setIsProfileModalOpen(false)}
                user={currentUser}
                onProfileUpdate={handleProfileUpdate}
                theme={theme}
                currentPhotoUrl={photoUrl}
            />
        </div>
    );
};


const Main = () => {
    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const savedTheme = localStorage.getItem('theme');
        return (savedTheme === 'light' || savedTheme === 'dark') ? savedTheme : 'dark';
    });

    useEffect(() => {
        try {
            const storedUser = sessionStorage.getItem('user');
            if (storedUser) {
                setCurrentUser(JSON.parse(storedUser));
            }
        } catch (error) {
            console.error("Failed to parse user from session storage:", error);
            sessionStorage.removeItem('user');
        }
        setIsLoading(false);
    }, []);

    useEffect(() => {
        document.documentElement.className = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

    const handleLogin = (user: User) => {
        setCurrentUser(user);
        sessionStorage.setItem('user', JSON.stringify(user));
    };

    const handleLogout = () => {
        setCurrentUser(null);
        sessionStorage.removeItem('user');
    };

    if (isLoading) {
        return (
            <div className={`h-screen w-screen flex justify-center items-center`} style={{ backgroundColor: 'var(--bg-primary)' }}>
                <Spinner message="Carregando..." />
            </div>
        );
    }

    if (!currentUser) {
        return <Auth onLoginSuccess={handleLogin} theme={theme} toggleTheme={toggleTheme} />;
    }

    return <App user={currentUser} onLogout={handleLogout} theme={theme} toggleTheme={toggleTheme} />;
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<Main />);
}

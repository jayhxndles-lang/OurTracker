import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { PortfolioData } from './types';

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore with firestoreDatabaseId as required
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Initialize Auth
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map((provider) => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connection on boot as required by Firebase skill
export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline or network is disconnected.');
    }
  }
}

function getFallbackUid(): string {
  const KEY = 'jf_device_uid';
  let uid = localStorage.getItem(KEY);
  if (!uid) {
    uid = 'anon_' + Math.random().toString(36).substring(2, 12);
    localStorage.setItem(KEY, uid);
  }
  return uid;
}

// Silently sign in anonymously in the background with graceful fallback
export function initAuth(): Promise<User> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
      } else {
        try {
          const cred = await signInAnonymously(auth);
          unsubscribe();
          resolve(cred.user);
        } catch (err: any) {
          unsubscribe();
          console.warn(
            'Firebase anonymous authentication is disabled in Firebase console (auth/admin-restricted-operation). Using device anonymous UID fallback.',
            err?.message || err
          );
          // Return fallback user object
          const fallbackUser = {
            uid: getFallbackUid(),
            isAnonymous: true,
          } as unknown as User;
          resolve(fallbackUser);
        }
      }
    });
  });
}

// Save portfolio data under the user's UID strictly in Firestore cloud database
export async function savePortfolio(userId: string, data: PortfolioData): Promise<void> {
  const docPath = `users/${userId}/portfolio/data`;
  try {
    const portfolioRef = doc(db, 'users', userId, 'portfolio', 'data');
    await setDoc(portfolioRef, {
      ...data,
      userId,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Firestore cloud save error at', docPath, error);
    throw error;
  }
}

// Load portfolio data strictly from Firestore in the cloud (no localStorage cache)
export async function loadPortfolio(userId: string): Promise<PortfolioData | null> {
  const docPath = `users/${userId}/portfolio/data`;
  
  // Clean up any legacy portfolio cache from localStorage
  try {
    localStorage.removeItem(`jf_portfolio_${userId}`);
  } catch {}

  try {
    const portfolioRef = doc(db, 'users', userId, 'portfolio', 'data');
    const snap = await getDoc(portfolioRef);
    if (snap.exists()) {
      return snap.data() as PortfolioData;
    }
  } catch (error) {
    console.error('Firestore cloud load error at', docPath, error);
    throw error;
  }

  return null;
}

export interface CachedTickerHistory {
  ticker: string;
  lastCachedDate: string;
  series: Array<{ date: string; close: number }>;
  updatedAt: string;
}

// Load ticker historical series from Firestore or local cache
export async function loadTickerHistory(
  userId: string,
  ticker: string
): Promise<CachedTickerHistory | null> {
  const normTicker = ticker.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const localKey = `jf_ticker_hist_${userId}_${normTicker}`;

  // Try Firestore
  try {
    const docRef = doc(db, 'users', userId, 'ticker_history', normTicker);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data() as CachedTickerHistory;
      try {
        localStorage.setItem(localKey, JSON.stringify(data));
      } catch {}
      return data;
    }
  } catch (error) {
    console.warn(`Firestore load ticker history skipped for ${ticker}:`, error);
  }

  // Fallback to local storage
  try {
    const local = localStorage.getItem(localKey);
    if (local) {
      return JSON.parse(local) as CachedTickerHistory;
    }
  } catch (e) {
    console.warn(`Local storage parse failed for ticker ${ticker}:`, e);
  }

  return null;
}

// Save ticker historical series to Firestore and local cache
export async function saveTickerHistory(
  userId: string,
  ticker: string,
  series: Array<{ date: string; close: number }>,
  lastCachedDate: string
): Promise<void> {
  const normTicker = ticker.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const localKey = `jf_ticker_hist_${userId}_${normTicker}`;
  const record: CachedTickerHistory = {
    ticker,
    lastCachedDate,
    series,
    updatedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(localKey, JSON.stringify(record));
  } catch {}

  try {
    const docRef = doc(db, 'users', userId, 'ticker_history', normTicker);
    await setDoc(docRef, record);
  } catch (error) {
    console.warn(`Firestore save ticker history skipped for ${ticker}:`, error);
  }
}


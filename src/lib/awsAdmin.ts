import * as admin from 'firebase-admin';
import { getAuth } from 'firebase-admin/auth';

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
    throw error;
  }
}

export interface UserPayload {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  customClaims?: { [key: string]: any };
}

export async function verifyFirebaseToken(token: string): Promise<UserPayload> {
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    
    // Get additional user info
    const userRecord = await getAuth().getUser(decodedToken.uid);
    
    return {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
      picture: userRecord.photoURL,
      customClaims: userRecord.customClaims
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Token verification failed: ${error.message}`);
    }
    throw new Error('Token verification failed');
  }
}

export async function getUserByEmail(email: string): Promise<UserPayload> {
  try {
    const userRecord = await getAuth().getUserByEmail(email);
    
    return {
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName,
      picture: userRecord.photoURL,
      customClaims: userRecord.customClaims
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`User lookup failed: ${error.message}`);
    }
    throw new Error('User lookup failed');
  }
}

export async function setCustomUserClaims(
  uid: string, 
  claims: { [key: string]: any }
): Promise<void> {
  try {
    await getAuth().setCustomUserClaims(uid, claims);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Setting custom claims failed: ${error.message}`);
    }
    throw new Error('Setting custom claims failed');
  }
}

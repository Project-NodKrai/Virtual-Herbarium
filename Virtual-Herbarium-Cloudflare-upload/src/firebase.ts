import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  projectId: "hypnagogic-charmer-8cf5x",
  appId: "1:701763042674:web:2948f8410e5429e7c931eb",
  apiKey: "AIzaSyBrOPPfA0hVIAxw7Uvmi70ODXTnmcJ2diY",
  authDomain: "hypnagogic-charmer-8cf5x.firebaseapp.com",
  storageBucket: "hypnagogic-charmer-8cf5x.firebasestorage.app",
  messagingSenderId: "701763042674",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, 'ai-studio-virtualherbarium-457a0c18-aee3-4c39-ac7f-d22db488f2e4');

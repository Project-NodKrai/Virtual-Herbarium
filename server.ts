import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import multer from "multer";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import * as OTPAuth from "otpauth";
import qrcode from "qrcode";

dotenv.config();

// Admin configuration - supports env variable with fallback to keep existing authenticator working
const ADMIN_USER = 'admin';
const ADMIN_SECRET = process.env.ADMIN_TOTP_SECRET || 'L2GPGSOPV6O4C4XZLBDAI7DXLXDTPTGY';

// Persistent storage for registered TOTP secrets
const DATA_DIR = path.join(process.cwd(), 'data');
const TOTP_STORE_FILE = path.join(DATA_DIR, 'totp-store.json');

function loadTotpSecrets(): Map<string, string> {
  const map = new Map<string, string>();
  map.set(ADMIN_USER, ADMIN_SECRET);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(TOTP_STORE_FILE)) {
      const content = fs.readFileSync(TOTP_STORE_FILE, 'utf-8');
      const data = JSON.parse(content);
      for (const [user, sec] of Object.entries(data)) {
        if (typeof user === 'string' && typeof sec === 'string') {
          map.set(user, sec);
        }
      }
    }
  } catch (err) {
    console.error('Failed to load persisted TOTP secrets:', err);
  }
  // Ensure admin is always present and up-to-date
  map.set(ADMIN_USER, ADMIN_SECRET);
  return map;
}

function saveTotpSecrets(map: Map<string, string>) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const record: Record<string, string> = {};
    for (const [user, sec] of map.entries()) {
      record[user] = sec;
    }
    fs.writeFileSync(TOTP_STORE_FILE, JSON.stringify(record, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save TOTP secrets to file:', err);
  }
}

const totpSecrets = loadTotpSecrets();

// Temporary pending setup sessions
interface PendingSetup {
  username: string;
  createdAt: number;
}
const pendingSetups = new Map<string, PendingSetup>();

function cleanPendingSetups() {
  const now = Date.now();
  for (const [secret, setup] of pendingSetups.entries()) {
    if (now - setup.createdAt > 10 * 60 * 1000) { // 10 minutes TTL
      pendingSetups.delete(secret);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Cloudflare R2 setup
  const upload = multer({ storage: multer.memoryStorage() });
  
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    }
  });

  // API Routes: Upload Image
  app.post("/api/upload-image", upload.single('image'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: '업로드할 이미지가 없습니다.' });
      
      const ext = file.originalname.split('.').pop() || 'jpg';
      const objectKey = `virtual-herbarium/plant/${uuidv4()}.${ext}`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      
      let publicUrlBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (publicUrlBase && !publicUrlBase.startsWith('http')) {
        publicUrlBase = `https://${publicUrlBase}`;
      }
      const publicUrl = `${publicUrlBase}/${objectKey}`;
      
      res.json({ url: publicUrl });
    } catch (error) {
      console.error('R2 upload error:', error);
      res.status(500).json({ error: '이미지 업로드에 실패했습니다.' });
    }
  });

  // API Routes: Delete Image
  app.delete("/api/delete-image", async (req, res) => {
    try {
      const { imageUrl } = req.body;
      if (!imageUrl) return res.status(400).json({ error: '이미지 URL이 제공되지 않았습니다.' });

      let publicUrlBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (publicUrlBase && !publicUrlBase.startsWith('http')) {
        publicUrlBase = `https://${publicUrlBase}`;
      }

      let objectKey = imageUrl;
      if (imageUrl.startsWith(publicUrlBase)) {
        objectKey = imageUrl.substring(publicUrlBase.length);
        if (objectKey.startsWith('/')) {
          objectKey = objectKey.substring(1);
        }
      } else {
        try {
          const parsedUrl = new URL(imageUrl);
          objectKey = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.substring(1) : parsedUrl.pathname;
        } catch {
          const urlParts = imageUrl.split('/');
          objectKey = urlParts[urlParts.length - 1];
        }
      }

      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
      }));

      res.json({ success: true });
    } catch (error) {
      console.error('R2 delete error:', error);
      res.status(500).json({ error: '이미지 삭제에 실패했습니다.' });
    }
  });

  // Proxy Logo - with CORS header to prevent canvas taint
  app.get('/api/proxy-logo', async (_req, res) => {
    try {
      const response = await fetch("https://data-herbarium.columbina.kr/virtual-herbarium/UI/logo.svg");
      if (!response.ok) throw new Error("Failed to fetch logo");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(buffer);
    } catch (error) {
      console.error('Logo proxy error:', error);
      res.status(500).send('Error proxying logo');
    }
  });

  // Check current session status (for backwards compatibility)
  app.get('/api/totp/session', (_req, res) => {
    res.json({ authenticated: true, username: ADMIN_USER, isAdmin: true });
  });

  // TOTP Routes: Status check
  app.get('/api/totp/status', (_req, res) => {
    const isRegistered = totpSecrets.has(ADMIN_USER);
    res.json({ isRegistered });
  });

  // List users
  app.get('/api/totp/users', (_req, res) => {
    res.json({ users: Array.from(totpSecrets.keys()) });
  });

  // Generate Setup QR code
  app.post('/api/totp/setup', async (req, res) => {
    try {
      cleanPendingSetups();
      const { username = ADMIN_USER } = req.body || {};
      
      // Clean any existing pending setup for the same username to avoid interference
      for (const [existingSecret, existingSetup] of pendingSetups.entries()) {
        if (existingSetup.username === username) {
          pendingSetups.delete(existingSecret);
        }
      }

      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      pendingSetups.set(secret, { username, createdAt: Date.now() });
      
      const totp = new OTPAuth.TOTP({
        issuer: 'VirtualHerbarium',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
      });
      
      const otpauthUrl = totp.toString();
      const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);
      
      res.json({ secret, qrCodeUrl, username });
    } catch (error) {
      console.error('TOTP setup error:', error);
      res.status(500).json({ error: 'TOTP 생성에 실패했습니다.' });
    }
  });

  // Cancel pending setup
  app.post('/api/totp/cancel-setup', (req, res) => {
    const { secret, username } = req.body || {};
    if (secret && pendingSetups.has(secret)) {
      pendingSetups.delete(secret);
    }
    if (username) {
      for (const [sec, setup] of pendingSetups.entries()) {
        if (setup.username === username) {
          pendingSetups.delete(sec);
        }
      }
    }
    res.json({ success: true });
  });

  // Verify setup & register
  app.post('/api/totp/verify-setup', (req, res) => {
    cleanPendingSetups();
    const { token, secret } = req.body;
    const pending = pendingSetups.get(secret);
    
    if (!pending) return res.status(400).json({ error: '설정 세션이 만료되었거나 존재하지 않습니다. 다시 시도해주세요.' });
    const username = pending.username;
    
    const totp = new OTPAuth.TOTP({
      issuer: 'VirtualHerbarium',
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret)
    });
    
    // Window of 2 periods (±60s) for robust time drift tolerance
    const delta = totp.validate({ token: String(token).trim(), window: 2 });
    const isValid = delta !== null;
    
    if (isValid) {
      totpSecrets.set(username, secret);
      saveTotpSecrets(totpSecrets);
      pendingSetups.delete(secret);
      
      res.json({
        success: true,
        username
      });
    } else {
      res.json({ success: false, error: '잘못된 인증 코드입니다.' });
    }
  });

  // Verify OTP for login
  app.post('/api/totp/verify', (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: '인증 코드를 입력해주세요.' });
    }
    
    if (totpSecrets.size === 0) {
      return res.status(400).json({ success: false, error: '등록된 OTP가 없습니다.' });
    }
    
    const cleanToken = String(token).trim();
    let validUser: string | null = null;
    for (const [user, secret] of totpSecrets.entries()) {
      const totp = new OTPAuth.TOTP({
        issuer: 'VirtualHerbarium',
        label: user,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
      });
      if (totp.validate({ token: cleanToken, window: 2 }) !== null) {
        validUser = user;
        break;
      }
    }
    
    if (validUser) {
      res.json({
        success: true,
        username: validUser
      });
    } else {
      res.json({ success: false, error: '인증 코드가 올바르지 않습니다.' });
    }
  });

  // Remove OTP
  app.post('/api/totp/remove', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '사용자 이름이 필요합니다.' });
    if (username === ADMIN_USER) {
      return res.status(400).json({ error: '최고 관리자(admin) OTP는 삭제할 수 없습니다.' });
    }
    
    totpSecrets.delete(username);
    saveTotpSecrets(totpSecrets);
    res.json({ success: true });
  });

  // Reset route
  app.post('/api/totp/reset', (_req, res) => {
    res.status(400).json({ error: '관리자 OTP는 초기화할 수 없습니다.' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

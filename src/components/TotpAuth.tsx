import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export interface TotpAuthProps {
  onSuccess: (username?: string, sessionToken?: string) => void;
  onCancel: () => void;
  lang: 'en' | 'ko';
  allowSetup?: boolean;
  setupUsername?: string;
  adminOnly?: boolean;
  title?: string;
  description?: string;
  authorizationToken?: string;
}

interface SetupData {
  secret: string;
  qrCodeUrl: string;
  setupToken: string;
}

export const TotpAuth: React.FC<TotpAuthProps> = ({
  onSuccess,
  onCancel,
  lang,
  allowSetup = false,
  setupUsername,
  adminOnly = false,
  title,
  description,
  authorizationToken
}) => {
  const navigate = useNavigate();
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [remainingTime, setRemainingTime] = useState(30);

  const isVerifyingRef = useRef(false);
  const setupDataRef = useRef<SetupData | null>(null);

  useEffect(() => {
    setupDataRef.current = setupData;
  }, [setupData]);

  useEffect(() => {
    if (allowSetup) {
      setIsRegistered(false);
      fetchSetupData();
      setLoading(false);
    } else {
      checkStatus();
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setRemainingTime(30 - (now % 30));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/totp/status');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || (lang === 'ko' ? 'OTP 저장소를 확인할 수 없습니다.' : 'Failed to check the OTP store.'));
      }
      setIsRegistered(data.isRegistered);
      if (!data.isRegistered && allowSetup) {
        await fetchSetupData();
      }
    } catch (err) {
      setError(err instanceof Error
        ? err.message
        : (lang === 'ko' ? '상태를 확인할 수 없습니다.' : 'Failed to check status.'));
    } finally {
      setLoading(false);
    }
  };

  const fetchSetupData = async () => {
    try {
      const res = await fetch('/api/totp/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorizationToken ? { Authorization: `Bearer ${authorizationToken}` } : {})
        },
        body: JSON.stringify({ username: setupUsername || 'admin' })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || (lang === 'ko' ? '설정 데이터를 가져올 수 없습니다.' : 'Failed to fetch setup data.'));
        return;
      }
      const qrCodeUrl = data.qrCodeUrl || await import('qrcode').then(({ default: QRCode }) => (
        QRCode.toDataURL(data.otpauthUrl, { width: 256, margin: 1 })
      ));
      setSetupData({
        secret: data.secret,
        setupToken: data.setupToken || '',
        qrCodeUrl,
      });
    } catch (err) {
      setError(lang === 'ko' ? '설정 데이터를 가져올 수 없습니다.' : 'Failed to fetch setup data.');
    }
  };

  const handleVerify = async (codeToVerify?: string) => {
    const code = (codeToVerify !== undefined ? codeToVerify : otpInput).trim();
    if (code.length !== 6) return;
    if (isVerifyingRef.current) return;

    isVerifyingRef.current = true;
    setVerifying(true);
    setError('');

    try {
      const currentSetupData = setupDataRef.current;
      // Registration and login are distinct flows. A temporary status-check
      // failure must not reroute a normal mutation login to verify-setup.
      const isSetupMode = allowSetup;
      const endpoint = !isSetupMode ? '/api/totp/verify' : '/api/totp/verify-setup';
      const bodyPayload = !isSetupMode
        ? { token: code }
        : {
            token: code,
            secret: currentSetupData?.secret,
            setupToken: currentSetupData?.setupToken,
          };
      
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });
      const data = await res.json();
      if (data.success) {
        if (adminOnly && data.username !== 'admin') {
          setError(lang === 'ko' ? '어드민(admin) 계정 OTP만 인증 가능합니다.' : 'Admin OTP is required.');
          setOtpInput('');
          return;
        }
        onSuccess(data.username, data.sessionToken);
      } else {
        setError(data.error || (lang === 'ko' ? '잘못된 코드입니다.' : 'Invalid code.'));
        setOtpInput('');
      }
    } catch (err) {
      setError(lang === 'ko' ? '인증에 실패했습니다.' : 'Verification failed.');
    } finally {
      isVerifyingRef.current = false;
      setVerifying(false);
    }
  };

  const handleInputChange = (rawVal: string) => {
    const cleaned = rawVal.replace(/\D/g, '').slice(0, 6);
    setOtpInput(cleaned);
    if (cleaned.length === 6 && !isVerifyingRef.current) {
      handleVerify(cleaned);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    const cleaned = pastedText.replace(/\D/g, '').slice(0, 6);
    if (cleaned) {
      setOtpInput(cleaned);
      if (cleaned.length === 6 && !isVerifyingRef.current) {
        handleVerify(cleaned);
      }
    }
  };

  const handleCancelClick = async () => {
    if (allowSetup && setupData?.secret) {
      try {
        await fetch('/api/totp/cancel-setup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            secret: setupData.secret,
            username: setupUsername || 'admin'
          })
        });
      } catch {
        // ignore cancellation error
      }
    }
    onCancel();
  };

  // Reset is now handled in the SecurityPage

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white p-6 rounded-lg shadow-xl w-96 max-w-[90vw] text-center">
          <p>{lang === 'ko' ? '로딩 중...' : 'Loading...'}</p>
        </div>
      </div>
    );
  }

  if (isRegistered === false && !allowSetup) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white p-6 rounded-lg shadow-xl w-96 max-w-[90vw] text-center">
          <h3 className="text-lg font-bold text-gray-900 mb-4">
            {lang === 'ko' ? '인증 필요' : 'Authentication Required'}
          </h3>
          <p className="text-sm text-gray-600 mb-6">
            {lang === 'ko' 
              ? 'OTP가 등록되지 않았습니다. 관리 기능을 이용하려면 OTP 관리 페이지에서 OTP를 먼저 등록해주세요.'
              : 'OTP is not registered. To use management features, please register an OTP in the OTP Management page first.'}
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
            >
              {lang === 'ko' ? '닫기' : 'Close'}
            </button>
            <button
              onClick={() => navigate('/security')}
              className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors"
            >
              {lang === 'ko' ? 'OTP 관리로 이동' : 'Go to Manage OTP'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-xl w-96 max-w-[90vw]">
        <h3 className="text-lg font-bold text-gray-900 mb-2 text-center">
          {title || (adminOnly ? (lang === 'ko' ? '어드민 OTP 인증' : 'Admin OTP Authentication') : (lang === 'ko' ? '사용자 인증' : 'User Authentication'))}
        </h3>
        {description && (
          <p className="text-sm text-gray-600 mb-4 text-center">
            {description}
          </p>
        )}
        {adminOnly && (
          <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 text-center font-medium">
            {lang === 'ko' ? '어드민(admin) 계정의 OTP 코드만 유효합니다.' : 'Only Admin OTP code is accepted.'}
          </div>
        )}
        
        {isRegistered === false && setupData && (
          <div className="mb-4 text-center">
            <p className="text-sm text-gray-600 mb-2">
              {lang === 'ko' 
                ? '아래 QR 코드를 Google Authenticator 등 인증 앱으로 스캔하여 등록하세요.' 
                : 'Scan the QR code below with an authenticator app (like Google Authenticator) to register.'}
            </p>
            <div className="flex justify-center mb-2">
              <img src={setupData.qrCodeUrl} alt="TOTP QR Code" className="w-48 h-48" />
            </div>
            <p className="text-xs text-gray-500 break-all mb-4">
              {lang === 'ko' ? 'Secret 키:' : 'Secret Key:'} {setupData.secret}
            </p>
          </div>
        )}

        <div className="text-center">
          <p className="text-sm font-medium text-gray-700 mb-2">
            {isRegistered === false
              ? (lang === 'ko' ? '인증 앱에 등록한 뒤, 화면에 표시된 6자리 코드를 입력하세요.' : 'After registering in the app, enter the 6-digit code shown.')
              : (lang === 'ko' ? '인증 앱의 6자리 코드를 입력하세요.' : 'Enter the 6-digit code from your authenticator app.')}
          </p>
          
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otpInput}
            onChange={(e) => handleInputChange(e.target.value)}
            onPaste={handlePaste}
            className="w-full text-center tracking-[0.5em] text-2xl font-mono border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-2"
            placeholder="000000"
            autoFocus
          />
          
          <p className="text-sm text-gray-500 mb-4">
            {remainingTime}{lang === 'ko' ? '초 후 갱신' : 's until refresh'}
          </p>
          
          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
          
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleCancelClick}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
            >
              {lang === 'ko' ? '취소' : 'Cancel'}
            </button>
            <button
              onClick={() => handleVerify()}
              disabled={otpInput.length !== 6 || verifying}
              className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              {verifying ? (lang === 'ko' ? '확인 중...' : 'Verifying...') : (lang === 'ko' ? '인증' : 'Verify')}
            </button>
          </div>

          {isRegistered && (
            <div className="mt-6 pt-4 border-t border-gray-100">
              <p className="text-xs text-gray-500 mb-2">
                {lang === 'ko' ? '사용자 인증: 활성화됨' : 'User Auth: Activated'}
              </p>
              <button
                onClick={() => navigate('/security')}
                className="text-xs text-blue-600 hover:underline"
              >
                {lang === 'ko' ? '[ OTP 관리 ]' : '[ Manage OTP ]'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TotpAuth } from './TotpAuth';
import { Shield, ShieldAlert, ShieldCheck, Trash2, Plus, UserCheck } from 'lucide-react';

interface TotpPersistenceStatus {
  mode: 'kv-encrypted' | 'r2-encrypted' | 'local';
  healthy: boolean;
}

export default function SecurityPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authenticatedUser, setAuthenticatedUser] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [persistence, setPersistence] = useState<TotpPersistenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Setup state
  const [showSetup, setShowSetup] = useState(false);
  const [setupUsername, setSetupUsername] = useState('');
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [showAdminVerifyForNewOtp, setShowAdminVerifyForNewOtp] = useState(false);
  const [adminSessionToken, setAdminSessionToken] = useState<string | null>(null);
  
  const navigate = useNavigate();

  const fetchData = async () => {
    try {
      setError('');
      const [statusRes, usersRes] = await Promise.all([
        fetch('/api/totp/status'),
        fetch('/api/totp/users')
      ]);
      
      const statusData = await statusRes.json();
      const usersData = await usersRes.json();

      if (!statusRes.ok) {
        throw new Error(statusData.error || 'OTP 저장소 상태를 확인할 수 없습니다.');
      }
      if (!usersRes.ok) {
        throw new Error(usersData.error || 'OTP 사용자 목록을 불러올 수 없습니다.');
      }
      
      setIsRegistered(statusData.isRegistered);
      setPersistence(statusData.persistence || null);
      if (usersData.users) {
        setUsers(usersData.users);
      }
      
      // If not registered, we don't need authentication to access this page initially
      if (!statusData.isRegistered && !isAuthenticated) {
        setIsAuthenticated(true);
        setAuthenticatedUser('admin');
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : '데이터를 불러올 수 없습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return <div className="p-8 text-center text-gray-500">로딩 중...</div>;
  }

  if (isRegistered === null) {
    return (
      <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-sm border border-red-200 mt-8">
        <div className="text-center py-8">
          <ShieldAlert className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2">OTP 저장소 연결 오류</h2>
          <p className="text-gray-600 mb-6">{error || 'OTP 저장소 상태를 확인할 수 없습니다.'}</p>
          <button
            onClick={() => { setLoading(true); void fetchData(); }}
            className="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  // Verify authentication before showing the page contents (Admin only)
  if (!isAuthenticated && isRegistered && !showSetup) {
    return (
      <TotpAuth
        lang="ko"
        adminOnly={true}
        title="보안 설정 관리자 인증"
        description="보안 설정(OTP 관리) 페이지는 어드민(admin) 계정만 접근할 수 있습니다."
        onSuccess={(username, sessionToken) => {
          if (username === 'admin') {
            setIsAuthenticated(true);
            setAuthenticatedUser('admin');
            setAdminSessionToken(sessionToken || null);
          } else {
            setError('어드민(admin) 계정만 접근할 수 있습니다.');
          }
        }}
        onCancel={() => navigate(-1)}
      />
    );
  }

  // Double check: if user is authenticated but not admin, deny access
  if (isAuthenticated && authenticatedUser && authenticatedUser !== 'admin') {
    return (
      <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-sm border border-gray-200 mt-8">
        <div className="text-center py-8">
          <ShieldAlert className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2">접근 권한 없음</h2>
          <p className="text-gray-600 mb-6">보안 설정 페이지는 어드민(admin) 계정만 접근할 수 있습니다. 일반 사용자는 접근이 제한됩니다.</p>
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
          >
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  // Admin verification prompt before adding a new general OTP
  if (showAdminVerifyForNewOtp) {
    return (
      <TotpAuth
        lang="ko"
        adminOnly={true}
        title="일반 OTP 추가 관리자 인증"
        description="새 일반 OTP를 발급하려면 먼저 어드민 인증 앱에 표시된 6자리 OTP 코드를 입력해주세요."
        onSuccess={(_username, sessionToken) => {
          setAdminSessionToken(sessionToken || null);
          setShowAdminVerifyForNewOtp(false);
          const newUsername = `user_${Math.floor(Math.random() * 100000)}`;
          setSetupUsername(newUsername);
          setShowSetup(true);
        }}
        onCancel={() => setShowAdminVerifyForNewOtp(false)}
      />
    );
  }

  // Modal for adding a new OTP user
  if (showSetup) {
    return (
      <TotpAuth
        lang="ko"
        allowSetup={true}
        setupUsername={setupUsername}
        authorizationToken={adminSessionToken || undefined}
        onSuccess={() => {
          setShowSetup(false);
          fetchData();
        }}
        onCancel={() => setShowSetup(false)}
      />
    );
  }

  const handleAddGeneralOtp = () => {
    // Require admin verification before issuing a new general OTP
    setShowAdminVerifyForNewOtp(true);
  };
  
  const handleAddAdminOtp = () => {
    setSetupUsername('admin');
    setShowSetup(true);
  };

  const confirmRemoveOtp = async (username: string) => {
    try {
      const res = await fetch('/api/totp/remove', { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminSessionToken ? { Authorization: `Bearer ${adminSessionToken}` } : {})
        },
        body: JSON.stringify({ username })
      });
      
      if (res.ok) {
        setDeletingUser(null);
        fetchData();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'OTP 제거에 실패했습니다.');
      }
    } catch (err) {
      setError('오류가 발생했습니다.');
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-sm border border-gray-200 mt-8">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-200">
        <Shield className="w-6 h-6 text-emerald-600" />
        <h1 className="text-2xl font-bold text-gray-900">OTP 관리 (보안 설정)</h1>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">{error}</div>}

      <div className="space-y-6">
        <div className="bg-gray-50 p-5 rounded-lg border border-gray-200">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
                사용자 인증 (OTP) 상태
                {isRegistered ? (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
                    <ShieldCheck className="w-3 h-3" /> 보호됨
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs font-medium">
                    <ShieldAlert className="w-3 h-3" /> 보호되지 않음
                  </span>
                )}
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                계정 보호를 위해 어드민 및 일반 접근을 위한 인증 앱을 관리합니다.
              </p>
            </div>
            
            <div className="flex gap-2">
              {isRegistered ? (
                <button
                  onClick={handleAddGeneralOtp} 
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  일반 OTP 추가
                </button>
              ) : (
                <button
                  onClick={handleAddAdminOtp}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition-colors text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  관리자 OTP 등록
                </button>
              )}
            </div>
          </div>

          {persistence && (
            <div className={`mb-4 rounded-md border px-3 py-2 text-xs ${
              (persistence.mode === 'r2-encrypted' || persistence.mode === 'kv-encrypted') && persistence.healthy
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}>
              OTP 저장 방식: {
                persistence.mode === 'kv-encrypted'
                  ? 'Cloudflare KV 암호화 영구 저장'
                  : persistence.mode === 'r2-encrypted'
                    ? 'R2 암호화 영구 저장'
                    : '로컬 파일 저장'
              }
            </div>
          )}
          
          <div className="mt-6">
            <h4 className="text-sm font-semibold text-gray-700 mb-3 border-b pb-2">등록된 OTP 목록</h4>
            {users.length > 0 ? (
              <ul className="space-y-3">
                {users.map(user => (
                  <li key={user} className="flex items-center justify-between p-3 bg-white border border-gray-200 rounded-md shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-full ${user === 'admin' ? 'bg-emerald-100 text-emerald-600' : 'bg-blue-100 text-blue-600'}`}>
                        <UserCheck className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {user === 'admin' ? '어드민 (최고 관리자)' : `일반 사용자 (${user})`}
                        </p>
                      </div>
                    </div>
                    {user !== 'admin' && (
                      <div className="flex gap-2 items-center">
                        {deletingUser === user ? (
                          <>
                            <button onClick={() => confirmRemoveOtp(user)} className="text-xs px-2 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 transition-colors">삭제 확인</button>
                            <button onClick={() => setDeletingUser(null)} className="text-xs px-2 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors">취소</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeletingUser(user)}
                            className="text-red-500 hover:text-red-700 p-2 rounded-md hover:bg-red-50 transition-colors"
                            title="OTP 제거"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500 text-center py-4">등록된 OTP가 없습니다.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

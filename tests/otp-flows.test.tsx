import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import SecurityPage from '../src/components/SecurityPage';
import { TotpAuth } from '../src/components/TotpAuth';

// All credentials below are isolated fixtures. No request leaves the mocked fetch.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
}

function button(label: string): ReactTestInstance {
  const match = renderer!.root.findAllByType('button').find(node => text(node) === label);
  assert.ok(match, `Expected button: ${label}`);
  return match;
}

async function enterCode(code: string): Promise<void> {
  await act(async () => {
    renderer!.root.findByType('input').props.onChange({ target: { value: code } });
  });
}

const setupFixture = {
  secret: 'JBSWY3DPEHPK3PXP',
  setupToken: 'fixture-setup-token',
  qrCodeUrl: 'data:image/png;base64,ZmFrZQ==',
};

test('general OTP enrollment starts a fresh setup flow after administrator verification', async () => {
  const requests: Array<{ path: string; options?: RequestInit }> = [];
  let verificationCount = 0;
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    requests.push({ path, options });
    if (path === '/api/totp/status') {
      return response({ isRegistered: true, persistence: { mode: 'kv-encrypted', healthy: true } });
    }
    if (path === '/api/totp/users') return response({ users: ['admin'] });
    if (path === '/api/totp/verify') {
      verificationCount += 1;
      return response({ success: true, username: 'admin', sessionToken: `fixture-admin-session-${verificationCount}` });
    }
    if (path === '/api/totp/setup') return response(setupFixture);
    if (path === '/api/totp/verify-setup') return response({ success: true, username: 'fixture-user' });
    throw new Error(`Unexpected request: ${path}`);
  };

  await act(async () => {
    renderer = create(<MemoryRouter><SecurityPage /></MemoryRouter>);
  });
  await enterCode('123456');
  await act(async () => button('일반 OTP 추가').props.onClick());
  await enterCode('234567');

  const setups = requests.filter(request => request.path === '/api/totp/setup');
  assert.equal(setups.length, 1, 'Admin verification must transition to a new enrollment request');
  assert.equal(new Headers(setups[0].options?.headers).get('Authorization'), 'Bearer fixture-admin-session-2');
  assert.match(JSON.parse(String(setups[0].options?.body)).username, /^user_/);
  assert.equal(renderer!.root.findByType('input').props.value, '', 'Do not reuse the administrator verification code');
  assert.equal(renderer!.root.findAllByProps({ alt: 'TOTP QR Code' }).length, 1);

  await enterCode('345678');
  const enrollments = requests.filter(request => request.path === '/api/totp/verify-setup');
  assert.equal(enrollments.length, 1);
  assert.deepEqual(JSON.parse(String(enrollments[0].options?.body)), {
    token: '345678',
    secret: setupFixture.secret,
    setupToken: setupFixture.setupToken,
  });
});

test('enrollment cannot verify a code before setup data is available', async () => {
  let finishSetup!: (value: Response) => void;
  const pendingSetup = new Promise<Response>(resolve => { finishSetup = resolve; });
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/totp/setup') return pendingSetup;
    if (path === '/api/totp/verify-setup') return response({ success: false, error: 'Setup missing' }, 400);
    throw new Error(`Unexpected request: ${path}`);
  };

  try {
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <TotpAuth lang="ko" allowSetup setupUsername="fixture-user" authorizationToken="fixture-admin-session" onSuccess={() => {}} onCancel={() => {}} />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      const input = renderer!.root.findAllByType('input')[0];
      input?.props.onChange({ target: { value: '123456' } });
    });
    assert.equal(requests.filter(path => path === '/api/totp/verify-setup').length, 0);
  } finally {
    await act(async () => finishSetup(response(setupFixture)));
  }
});

test('a normal specimen authorization receives its session token and never uses the setup endpoint', async () => {
  const requests: string[] = [];
  const authorized: unknown[][] = [];
  globalThis.fetch = async input => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/totp/status') return response({ isRegistered: true });
    if (path === '/api/totp/verify') return response({ success: true, username: 'admin', sessionToken: 'fixture-mutation-token' });
    throw new Error(`Unexpected request: ${path}`);
  };
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <TotpAuth lang="ko" title="표본 수정 OTP 인증" onSuccess={(...args) => { authorized.push(args); }} onCancel={() => {}} />
      </MemoryRouter>,
    );
  });
  await enterCode('123456');
  assert.deepEqual(authorized, [['admin', 'fixture-mutation-token']]);
  assert.deepEqual(requests, ['/api/totp/status', '/api/totp/verify']);
});

test('canceling verification aborts the request and ignores a late success response', async () => {
  let finishVerification!: (value: Response) => void;
  const pendingVerification = new Promise<Response>(resolve => { finishVerification = resolve; });
  let verificationSignal: AbortSignal | undefined;
  let verificationRequests = 0;
  let canceled = 0;
  const authorized: unknown[][] = [];
  globalThis.fetch = async (input, options) => {
    if (String(input) === '/api/totp/status') return response({ isRegistered: true });
    if (String(input) === '/api/totp/verify') {
      verificationRequests += 1;
      verificationSignal = options?.signal || undefined;
      // Deliberately ignore abort to cover a response already in transit.
      return pendingVerification;
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <TotpAuth lang="ko" onSuccess={(...args) => authorized.push(args)} onCancel={() => { canceled += 1; }} />
      </MemoryRouter>,
    );
  });
  await enterCode('123456');
  await act(async () => button('취소').props.onClick());
  assert.equal(canceled, 1);
  assert.equal(verificationSignal?.aborted, true);
  await enterCode('234567');
  assert.equal(verificationRequests, 1, 'A canceled flow cannot start another verification');
  await act(async () => finishVerification(response({ success: true, username: 'admin', sessionToken: 'fixture-canceled-token' })));
  assert.deepEqual(authorized, [], 'Cancel must prevent a delayed save or delete callback');
});

test('unmounting verification ignores a late success response', async () => {
  let finishVerification!: (value: Response) => void;
  const pendingVerification = new Promise<Response>(resolve => { finishVerification = resolve; });
  let verificationSignal: AbortSignal | undefined;
  const authorized: unknown[][] = [];
  globalThis.fetch = async (input, options) => {
    if (String(input) === '/api/totp/status') return response({ isRegistered: true });
    verificationSignal = options?.signal || undefined;
    return pendingVerification;
  };
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <TotpAuth lang="ko" onSuccess={(...args) => authorized.push(args)} onCancel={() => {}} />
      </MemoryRouter>,
    );
  });
  await enterCode('123456');
  await act(async () => renderer!.unmount());
  renderer = undefined;
  assert.equal(verificationSignal?.aborted, true);
  await act(async () => finishVerification(response({ success: true, username: 'admin', sessionToken: 'fixture-unmounted-token' })));
  assert.deepEqual(authorized, []);
});

test('changing the OTP flow discards old verification without unlocking the new request', async () => {
  let finishOldVerification!: (value: Response) => void;
  let finishNewVerification!: (value: Response) => void;
  const oldVerification = new Promise<Response>(resolve => { finishOldVerification = resolve; });
  const newVerification = new Promise<Response>(resolve => { finishNewVerification = resolve; });
  let oldSignal: AbortSignal | undefined;
  const authorized: unknown[][] = [];
  const onSuccess = (...args: unknown[]) => { authorized.push(args); };
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path === '/api/totp/status') return response({ isRegistered: true });
    if (path === '/api/totp/setup') return response(setupFixture);
    if (path === '/api/totp/verify') {
      oldSignal = options?.signal || undefined;
      return oldVerification;
    }
    if (path === '/api/totp/verify-setup') return newVerification;
    throw new Error(`Unexpected request: ${path}`);
  };
  await act(async () => {
    renderer = create(
      <MemoryRouter><TotpAuth lang="ko" onSuccess={onSuccess} onCancel={() => {}} /></MemoryRouter>,
    );
  });
  await enterCode('123456');
  await act(async () => {
    renderer!.update(
      <MemoryRouter>
        <TotpAuth lang="ko" allowSetup setupUsername="fixture-user" authorizationToken="fixture-admin-token" onSuccess={onSuccess} onCancel={() => {}} />
      </MemoryRouter>,
    );
  });
  assert.equal(oldSignal?.aborted, true);
  assert.equal(renderer!.root.findByType('input').props.value, '');
  await enterCode('234567');
  await act(async () => finishOldVerification(response({ success: true, username: 'admin', sessionToken: 'fixture-stale-token' })));
  assert.deepEqual(authorized, []);
  assert.equal(button('확인 중...').props.disabled, true, 'The old request must not clear the new verification lock');
  await act(async () => finishNewVerification(response({ success: true, username: 'fixture-user' })));
  assert.deepEqual(authorized, [['fixture-user', undefined]]);
});

import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChartColumn, House, Images, Leaf, Menu, ShieldCheck, X } from 'lucide-react';

const tabs = [
  { to: '/home', label: '홈', icon: House },
  { to: '/data', label: '표본관', icon: Leaf },
  { to: '/gallery', label: '갤러리', icon: Images },
];

export function MobileMenu() {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  useEffect(() => {
    dialog.current?.close();
  }, [location]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) dialog.current?.close();
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  function closeMenu() {
    dialog.current?.close();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="전체 메뉴 열기"
        aria-haspopup="dialog"
        aria-controls="mobile-menu"
        className="md:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-700 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        onClick={() => dialog.current?.showModal()}
      >
        <Menu size={24} aria-hidden="true" />
      </button>

      <dialog
        ref={dialog}
        id="mobile-menu"
        aria-labelledby="mobile-menu-title"
        className="mobile-menu md:hidden fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(20rem,calc(100vw-2rem))] max-w-none border-0 bg-white p-0 text-gray-900 shadow-xl"
        onClose={() => button.current?.focus()}
        onClick={event => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeMenu();
        }}
      >
        <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
            <h2 id="mobile-menu-title" className="text-lg font-bold">전체 메뉴</h2>
            <button type="button" autoFocus onClick={closeMenu} aria-label="전체 메뉴 닫기" className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-emerald-600">
              <X size={24} aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="모바일 전체 메뉴" className="flex-1 overflow-y-auto p-4">
            <div className="space-y-1">
              {tabs.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} onClick={closeMenu} className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-4 font-medium ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-gray-700 hover:bg-gray-50'}`}>
                  <Icon size={21} aria-hidden="true" />{label}
                </NavLink>
              ))}
            </div>
            <p className="mt-6 mb-2 px-4 text-xs font-semibold text-gray-500">표본 통계</p>
            <div className="space-y-1">
              {[
                { to: '/chart/order', label: '분류별 통계' },
                { to: '/chart/date', label: '채집일별 통계' },
                { to: '/chart/collector', label: '채집자별 통계' },
              ].map(({ to, label }) => (
                <NavLink key={to} to={to} onClick={closeMenu} className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-4 font-medium ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-gray-700 hover:bg-gray-50'}`}>
                  <ChartColumn size={21} aria-hidden="true" />{label}
                </NavLink>
              ))}
            </div>
            <div className="mt-4 border-t border-gray-100 pt-4">
              <NavLink to="/security" onClick={closeMenu} className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-xl px-4 font-medium ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-gray-700 hover:bg-gray-50'}`}>
                <ShieldCheck size={21} aria-hidden="true" />보안 · OTP 관리
              </NavLink>
            </div>
          </nav>
        </div>
      </dialog>
    </>
  );
}

export default function MobileNavigation() {
  return (
    <nav aria-label="모바일 주요 메뉴" className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgb(0_0_0/0.04)]">
      <div className="grid h-16 grid-cols-3">
        {tabs.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-emerald-600 ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-gray-500 hover:text-emerald-700'}`}>
            <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

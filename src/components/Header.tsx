import { Link, useLocation } from 'react-router-dom';

export default function Header() {
  const location = useLocation();
  const path = location.pathname;

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-20 items-center">
          <Link to="/home" className="flex items-center group">
            <img 
              src="https://data-herbarium.columbina.kr/virtual-herbarium/UI/logo.svg" 
              alt="Virtual Herbarium Logo" 
              className="h-10 w-auto mr-3 object-contain group-hover:scale-105 transition-transform" 
            />
            <span className="font-bold text-2xl text-gray-900 tracking-tight">Virtual Herbarium</span>
          </Link>
          <nav className="hidden md:flex space-x-8 items-center">
            <Link
              to="/home"
              className={`font-medium transition-colors ${
                path === '/home' || path === '/'
                  ? 'text-emerald-600 font-semibold border-b-2 border-emerald-600 py-2'
                  : 'text-gray-600 hover:text-emerald-600 py-2'
              }`}
            >
              Home
            </Link>
            <Link
              to="/data"
              className={`font-medium transition-colors ${
                path.startsWith('/data')
                  ? 'text-emerald-600 font-semibold border-b-2 border-emerald-600 py-2'
                  : 'text-gray-600 hover:text-emerald-600 py-2'
              }`}
            >
              Herbarium
            </Link>
            <Link 
              to="/gallery" 
              className={`font-medium transition-colors ${
                path.startsWith('/gallery')
                  ? 'text-emerald-600 font-semibold border-b-2 border-emerald-600 py-2'
                  : 'text-gray-600 hover:text-emerald-600 py-2'
              }`}
            >
              Gallery
            </Link>
            <a href="#" className="text-gray-600 font-medium hover:text-emerald-600 transition-colors py-2">
              Contacts
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}

import { Link, useLocation } from 'react-router-dom';

export default function Sidebar() {
  const location = useLocation();
  const path = location.pathname;

  return (
    <div className="w-64 flex-shrink-0 border-r border-gray-200 pr-6 hidden md:block">
      <div className="bg-gray-50 border border-gray-100 rounded-lg p-5">
        <h2 className="text-lg font-bold text-gray-900 mb-4 pb-3 border-b-2 border-emerald-500 uppercase tracking-wider">Herbarium</h2>
        <ul className="space-y-3 text-sm">
          <li>
            <Link to="/home" className={`${path === '/home' ? 'text-emerald-600 font-semibold before:text-emerald-500' : 'text-gray-600 hover:text-emerald-600 font-medium before:text-gray-400'} flex items-center before:content-['-'] before:mr-2 transition-colors`}>
              Home
            </Link>
          </li>
          <li>
            <Link to="/gallery" className={`${path === '/gallery' ? 'text-emerald-600 font-semibold before:text-emerald-500' : 'text-gray-600 hover:text-emerald-600 font-medium before:text-gray-400'} flex items-center before:content-['-'] before:mr-2 transition-colors`}>
              Gallery
            </Link>
          </li>
          <li>
            <Link to="/data" className={`${path.startsWith('/data') ? 'text-emerald-600 font-semibold before:text-emerald-500' : 'text-gray-600 hover:text-emerald-600 font-medium before:text-gray-400'} flex items-center before:content-['-'] before:mr-2 transition-colors`}>
              Herbarium List
            </Link>
          </li>
          <li>
            <div className={`${path.startsWith('/chart') ? 'text-emerald-600 font-semibold before:text-emerald-500' : 'text-gray-600 font-medium before:text-gray-400'} flex items-center before:content-['-'] before:mr-2`}>
              Herbarium Chart
            </div>
          </li>
          <li className="pl-5">
            <Link to="/chart/order" className={`${path === '/chart/order' ? 'text-emerald-600 font-semibold' : 'text-gray-500 hover:text-emerald-600'} transition-colors flex items-center before:content-['·'] before:mr-2 before:text-gray-400 before:font-bold`}>
              Order Chart
            </Link>
          </li>
          <li className="pl-5">
            <Link to="/chart/date" className={`${path === '/chart/date' ? 'text-emerald-600 font-semibold' : 'text-gray-500 hover:text-emerald-600'} transition-colors flex items-center before:content-['·'] before:mr-2 before:text-gray-400 before:font-bold`}>
              Date Chart
            </Link>
          </li>
          <li className="pl-5">
            <Link to="/chart/collector" className={`${path === '/chart/collector' ? 'text-emerald-600 font-semibold' : 'text-gray-500 hover:text-emerald-600'} transition-colors flex items-center before:content-['·'] before:mr-2 before:text-gray-400 before:font-bold`}>
              Collector Chart
            </Link>
          </li>
          <li className="pt-2">
            <Link to="/security" className={`${path === '/security' ? 'text-emerald-600 font-semibold before:text-emerald-500' : 'text-gray-600 hover:text-emerald-600 font-medium before:text-gray-400'} flex items-center before:content-['-'] before:mr-2 transition-colors`}>
              Security
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

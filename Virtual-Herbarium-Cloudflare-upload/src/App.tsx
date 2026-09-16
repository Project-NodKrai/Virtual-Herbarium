/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Home from './components/Home';
import Gallery from './components/Gallery';
import HerbariumList from './components/HerbariumList';
import HerbariumDetail from './components/HerbariumDetail';
import ChartViews from './components/ChartViews';
import SecurityPage from './components/SecurityPage';

function AppLayout() {
  const location = useLocation();
  const isHome = location.pathname === '/home' || location.pathname === '/';

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] font-sans text-gray-900">
      <Header />
      
      <main className={`flex-1 w-full ${isHome ? '' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8'}`}>
        <div className={`flex flex-col md:flex-row gap-8 ${isHome ? 'h-full' : ''}`}>
          {!isHome && <Sidebar />}
          <div className={`${isHome ? 'w-full flex-1' : 'flex-1 min-w-0'}`}>
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<Home />} />
              <Route path="/gallery" element={<Gallery />} />
              <Route path="/data" element={<HerbariumList />} />
              <Route path="/data/new" element={<HerbariumDetail />} />
              <Route path="/data/:id" element={<HerbariumDetail />} />
              <Route path="/chart/:type" element={<ChartViews />} />
              <Route path="/security" element={<SecurityPage />} />
            </Routes>
          </div>
        </div>
      </main>

      {!isHome && (
        <footer className="bg-white border-t border-gray-200 py-8 mt-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center text-sm text-gray-500 gap-4">
            <div className="flex items-center gap-4">
              <img src="/api/proxy-logo" alt="Virtual Herbarium Logo" className="h-6 w-auto object-contain" />
              <span className="hidden md:inline-block w-px h-4 bg-gray-300"></span>
              <span>Green Eco Club</span>
            </div>
            <div>
              &copy; 2026 Virtual Herbarium. All Rights Reserved.
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <AppLayout />
    </Router>
  );
}

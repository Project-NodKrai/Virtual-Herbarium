import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { getRecords } from '../db';

export default function Home() {
  const [searchTerm, setSearchTerm] = useState('');
  const [totalRecords, setTotalRecords] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    getRecords().then(records => {
      setTotalRecords(records.length);
    }).catch(console.error);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTerm.trim()) {
      navigate(`/data?search=${encodeURIComponent(searchTerm)}`);
    } else {
      navigate('/data');
    }
  };

  return (
    <div className="flex-1 w-full flex flex-col relative h-full min-h-[calc(100vh-73px)]">
      {/* Background Image / Overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-center z-0"
        style={{ backgroundImage: 'url("https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?q=80&w=2000&auto=format&fit=crop")' }}
      >
        <div className="absolute inset-0 bg-black/50"></div>
      </div>

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center justify-center flex-1 w-full px-4 sm:px-6 lg:px-8 py-20 text-center">
        
        {/* Title Area */}
        <div className="mb-12">
          <div className="flex justify-center">
            <Link to="/home" className="flex items-center group">
              <img 
                src="https://data-herbarium.columbina.kr/virtual-herbarium/UI/logo.svg" 
                alt="Virtual Herbarium Logo" 
                style={{ paddingLeft: '0px' }}
                className="h-14 sm:h-16 w-auto mr-4 object-contain group-hover:scale-105 transition-transform" 
              />
              <span className="font-bold text-4xl sm:text-5xl md:text-6xl text-white tracking-tight">가상 식물표본관</span>
            </Link>
          </div>
          <p className="text-white text-xl sm:text-2xl md:text-3xl font-medium mt-12">
            검색가능 표본자원 총 <span className="text-[#ffeb3b] font-bold">{totalRecords.toLocaleString()}</span>건
          </p>
        </div>

        {/* Search Bar */}
        <form onSubmit={handleSearch} className="w-full max-w-3xl mx-auto flex flex-col sm:flex-row shadow-2xl sm:rounded-full overflow-hidden">
          <div className="flex flex-1 bg-white rounded-t-2xl sm:rounded-none relative items-center px-2">
            <Search className="w-6 h-6 text-gray-400 absolute left-6" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 pl-14 pr-6 py-5 sm:py-6 text-lg sm:text-xl text-gray-800 placeholder-gray-400 focus:outline-none bg-white w-full"
              placeholder="Search keyword..."
            />
          </div>
          <button type="submit" className="bg-[#2d316c] hover:bg-[#1a1c4b] text-white px-10 sm:px-14 py-5 sm:py-6 flex items-center justify-center transition-colors rounded-b-2xl sm:rounded-none">
            <Search className="w-6 h-6 mr-2 sm:w-7 sm:h-7" />
            <span className="text-lg sm:text-xl font-bold uppercase tracking-wider">Search</span>
          </button>
        </form>

      </div>
    </div>
  );
}

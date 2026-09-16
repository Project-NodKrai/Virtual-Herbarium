import { useState, useMemo, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight, FilterX, Plus } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { HerbariumRecord } from '../types';
import { getRecords } from '../db';

const TABS = ['ALL', 'Plant'];
const ITEMS_PER_PAGE = 20;

export default function HerbariumList() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '');
  const [currentPage, setCurrentPage] = useState(1);
  const [data, setData] = useState<HerbariumRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();

  useEffect(() => {
    getRecords()
      .then(records => {
        setData(records);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const filteredData = useMemo(() => {
    return data.filter((item) => {
      const matchTab = activeTab === 'ALL' || item.type === activeTab;
      const matchSearch = item.scientificName?.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          item.koreanName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.genus?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.id?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchTab && matchSearch;
    });
  }, [activeTab, searchQuery, data]);

  const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE) || 1;
  const paginatedData = filteredData.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  // Determine pagination range to show (e.g. max 5 pages)
  const getPageNumbers = () => {
    const pages = [];
    let start = Math.max(1, currentPage - 2);
    let end = Math.min(totalPages, start + 4);
    
    if (end - start < 4) {
      start = Math.max(1, end - 4);
    }
    
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Herbarium List</h1>
      </div>
      
      {/* Tabs */}
      <div className="flex space-x-1 mb-6 border-b border-gray-200 overflow-x-auto hide-scrollbar">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setCurrentPage(1); }}
            className={`px-5 py-2.5 font-medium text-sm whitespace-nowrap rounded-t-lg transition-colors ${
              activeTab === tab
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50 border-t border-l border-r border-transparent hover:border-gray-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Search and Stats */}
      <div className="flex flex-col sm:flex-row justify-between items-center mb-5 gap-4 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
        <div className="flex w-full sm:w-auto relative">
          <input
            type="text"
            placeholder="Search keyword..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full sm:w-80 border border-gray-300 rounded-md pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm"
          />
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        </div>
        <div className="text-sm text-gray-500 bg-gray-50 px-3 py-1.5 rounded-md border border-gray-100">
          Total: <span className="text-emerald-600 font-bold ml-1">{filteredData.length.toLocaleString()}</span> items
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg shadow-sm">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-gray-50/80 border-b border-gray-200 text-gray-700">
            <tr>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">ID</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Common Taxon</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Genus</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Scientific Name</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Korean Name</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Family</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Location</th>
              <th className="px-5 py-3.5 font-semibold text-xs uppercase tracking-wider text-gray-500">Coll. No.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-5 py-16 text-center">
                  <div className="flex justify-center items-center">
                    <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                  </div>
                </td>
              </tr>
            ) : paginatedData.length > 0 ? (
              paginatedData.map((item) => (
                <tr 
                  key={item.id} 
                  onClick={() => navigate(`/data/${item.id}`)}
                  className="hover:bg-emerald-50/50 transition-colors group cursor-pointer"
                >
                  <td className="px-5 py-3 font-medium text-gray-900">{item.id}</td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                      {item.type}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-700">{item.genus}</td>
                  <td className="px-5 py-3 italic text-gray-800 font-medium group-hover:text-emerald-700">{item.scientificName}</td>
                  <td className="px-5 py-3 text-gray-600">{item.koreanName}</td>
                  <td className="px-5 py-3 text-gray-600">{item.family}</td>
                  <td className="px-5 py-3 text-gray-500 truncate max-w-[200px]" title={item.location}>{item.location}</td>
                  <td className="px-5 py-3 text-gray-500">{item.collectionNo}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center justify-center text-gray-400">
                    <FilterX className="w-12 h-12 mb-4 text-gray-300" />
                    <p className="text-base font-medium text-gray-600">No records found</p>
                    <p className="text-sm mt-1">Try adjusting your search or filters.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Action / Write Button */}
      <div className="flex justify-end mt-4">
        <button
          onClick={() => navigate('/data/new')}
          className="flex items-center px-4 py-2 bg-emerald-600 rounded-md text-sm font-medium text-white hover:bg-emerald-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4 mr-2" />
          Write Record
        </button>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center mt-8 space-x-2">
          <button
            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
            disabled={currentPage === 1}
            className="p-2 border border-gray-300 rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 text-gray-600 bg-white shadow-sm transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          
          {getPageNumbers().map((num) => (
            <button
              key={num}
              onClick={() => setCurrentPage(num)}
              className={`px-3.5 py-2 text-sm font-medium border rounded-md min-w-[40px] transition-colors shadow-sm ${
                currentPage === num
                  ? 'bg-emerald-600 text-white border-emerald-600' 
                  : 'bg-white border-gray-300 hover:bg-gray-50 text-gray-700'
              }`}
            >
              {num}
            </button>
          ))}

          <button
            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
            disabled={currentPage === totalPages}
            className="p-2 border border-gray-300 rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 text-gray-600 bg-white shadow-sm transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

    </div>
  );
}

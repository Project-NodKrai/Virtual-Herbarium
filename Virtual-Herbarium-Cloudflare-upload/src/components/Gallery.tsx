import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getRecords } from '../db';
import { HerbariumRecord } from '../types';
import { Image as ImageIcon } from 'lucide-react';

export default function Gallery() {
  const [records, setRecords] = useState<HerbariumRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchRecords = async () => {
      try {
        const fetchedRecords = await getRecords();
        // Only keep records that have an image
        const recordsWithImages = fetchedRecords.filter(r => r.image && r.image.trim() !== '');
        setRecords(recordsWithImages);
      } catch (err) {
        console.error('Failed to fetch records:', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchRecords();
  }, []);

  if (isLoading) {
    return (
      <div className="flex-1 bg-white border border-gray-200 rounded-lg shadow-sm flex items-center justify-center p-12 h-64">
        <div className="text-gray-500 font-medium">Loading gallery...</div>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="flex-1 bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col items-center justify-center p-12 min-h-64">
        <ImageIcon className="w-12 h-12 text-gray-300 mb-4" />
        <p className="text-gray-500 font-medium text-lg">No images available</p>
        <p className="text-gray-400 text-sm mt-1">Upload images in the Herbarium List to see them here.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 w-full">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Gallery</h1>
        <div className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
          {records.length} {records.length === 1 ? 'Image' : 'Images'}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {records.map(record => (
          <Link 
            key={record.id} 
            to={`/data/${record.id}`}
            className="group flex flex-col bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden hover:shadow-md hover:border-emerald-300 transition-all duration-200"
          >
            <div className="relative aspect-square w-full bg-gray-100 overflow-hidden">
              <img 
                src={record.image.startsWith('http') || record.image.startsWith('/') || record.image.startsWith('data:') ? record.image : `https://${record.image}`}
                alt={record.koreanName || record.scientificName || 'Herbarium specimen'} 
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="p-4 flex flex-col items-center text-center bg-white border-t border-gray-100">
              <h3 className="font-bold text-gray-900 text-lg mb-1 line-clamp-1 group-hover:text-emerald-700 transition-colors">
                {record.koreanName || '이름 없음'}
              </h3>
              <p className="text-sm text-gray-500 italic line-clamp-1">
                {record.scientificName || 'Unknown Species'}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

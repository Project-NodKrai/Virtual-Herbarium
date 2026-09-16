import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { HerbariumRecord } from '../types';
import { getRecords } from '../db';

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#64748b', '#84cc16'];

export default function ChartViews() {
  const { type } = useParams<{ type: string }>();
  const [records, setRecords] = useState<HerbariumRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getRecords()
      .then(data => {
        setRecords(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const chartData = useMemo(() => {
    if (!records.length) return [];

    const counts: Record<string, number> = {};

    if (type === 'order') {
      records.forEach(r => {
        const val = r.order || 'Unknown';
        counts[val] = (counts[val] || 0) + 1;
      });
      const total = records.length;
      const aggregated: { name: string, value: number }[] = [];
      let otherCount = 0;
      
      Object.entries(counts).forEach(([name, count]) => {
        if (count / total < 0.05) { // less than 5% goes to other
          otherCount += count;
        } else {
          aggregated.push({ name, value: count });
        }
      });
      
      if (otherCount > 0) {
        aggregated.push({ name: 'Other', value: otherCount });
      }
      return aggregated.sort((a, b) => b.value - a.value);
    }

    if (type === 'date') {
      records.forEach(r => {
        const val = r.collDate || 'Unknown';
        counts[val] = (counts[val] || 0) + 1;
      });
      return Object.entries(counts)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (type === 'collector') {
      records.forEach(r => {
        const val = r.collector || 'Unknown';
        counts[val] = (counts[val] || 0) + 1;
      });
      return Object.entries(counts)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
    }

    return [];
  }, [records, type]);

  if (loading) {
    return (
      <div className="flex-1 flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-6">
        <div className="bg-red-50 text-red-700 p-4 rounded-md">{error}</div>
      </div>
    );
  }

  const renderChart = () => {
    if (type === 'order') {
      return (
        <ResponsiveContainer width="100%" height={450}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              labelLine={true}
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              outerRadius={160}
              innerRadius={80} // Donut style
              fill="#8884d8"
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip 
              formatter={(value: number) => [`${value} records`, 'Count']}
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
            />
            <Legend wrapperStyle={{ paddingTop: '20px' }}/>
          </PieChart>
        </ResponsiveContainer>
      );
    }

    // date or collector
    return (
      <ResponsiveContainer width="100%" height={450}>
        <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis 
            dataKey="name" 
            angle={type === 'date' ? -45 : 0} 
            textAnchor={type === 'date' ? 'end' : 'middle'} 
            tickMargin={10}
            stroke="#64748b"
          />
          <YAxis stroke="#64748b" />
          <Tooltip 
            cursor={{ fill: '#f1f5f9' }}
            formatter={(value: number) => [`${value} records`, 'Count']}
            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
          />
          <Bar dataKey="value" fill="#10b981" radius={[4, 4, 0, 0]} name="Count" />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const titles: Record<string, string> = {
    order: 'Order Distribution',
    date: 'Collection Dates',
    collector: 'Records by Collector'
  };

  const descriptions: Record<string, string> = {
    order: '분류군(목)별 표본 비율을 보여줍니다. 비율이 작은 항목(<5%)은 "기타"로 그룹화됩니다.',
    date: '날짜별 수집된 표본 수를 표시합니다.',
    collector: '채집자별 수집된 표본 수를 표시합니다.'
  };

  return (
    <div className="flex-1 min-w-0 bg-white p-6 rounded-lg shadow-sm border border-gray-200">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 tracking-tight">{titles[type || ''] || 'Chart'}</h2>
        <p className="text-gray-500 mt-1">{descriptions[type || '']}</p>
      </div>
      
      <div className="w-full h-[500px] bg-gray-50/30 rounded-xl p-4 border border-gray-100 flex items-center justify-center">
        {chartData.length > 0 ? renderChart() : <p className="text-gray-500">No data available for this metric.</p>}
      </div>
    </div>
  );
}

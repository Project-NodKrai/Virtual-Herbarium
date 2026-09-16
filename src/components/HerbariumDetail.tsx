import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { HerbariumRecord } from '../types';
import { getRecordById, saveRecord, deleteRecord } from '../db';
import { ArrowLeft, Save, Trash2, Edit2, Image as ImageIcon, Languages, Download } from 'lucide-react';
import html2canvas from 'html2canvas';
import familyDataCsv from './family_data.csv?raw';
import speciesDataCsv from '../../species_data.csv.csv?raw';
import { TotpAuth } from './TotpAuth';

const familySuggestions = familyDataCsv
  .split('\n')
  .slice(1)
  .map(line => line.split(',')[1]?.trim())
  .filter(Boolean);

const speciesRows = speciesDataCsv.split('\n').slice(1).filter(l => l.trim().length > 0);
const koreanNameSuggestions = Array.from(new Set(
  speciesRows.map(line => line.split(',')[1]?.trim()).filter(Boolean)
));
const scientificNameSuggestions = Array.from(new Set(
  speciesRows
    .map(line => line.split(',')[11]?.trim())
    .filter(Boolean)
    .filter(name => !/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(name))
));

const t = {
  en: {
    taxonomicInfo: "1. Taxonomic Information",
    commonTaxon: "Common Taxon",
    scientificName: "Scientific Name",
    koreanName: "Korean Name",
    kingdom: "Kingdom",
    divisionPhylum: "Division/Phylum",
    class: "Class",
    order: "Order",
    family: "Family",
    genus: "Genus",
    collectionInfo: "2. Collection information",
    collector: "Collector",
    collDate: "Coll. Date",
    collNo: "Coll. No.",
    determinationInfo: "3. Determination Information",
    detBy: "Det. by",
    localityInfo: "4. Locality Information",
    location: "Location",
    specificLocality: "Specific Locality",
    habitatInfo: "Habitat Information",
    latitude: "Latitude",
    longitude: "Longitude",
    altitudeDepth: "Altitude / Depth",
    specimenInfo: "5. Specimen information",
    specimenName: "Herbarium Specimen Name",
    specimenNote: "Herbarium Specimen Note",
    list: "LIST",
    edit: "Edit",
    delete: "Delete",
    save: "Save",
    cancel: "Cancel",
    newRecord: "New Herbarium Record",
    viewRecord: "Herbarium View",
    photo: "Specimen Photo",
  },
  ko: {
    taxonomicInfo: "1. 분류 정보 (Taxonomic Information)",
    commonTaxon: "일반 분류군 (Common Taxon)",
    scientificName: "학명 (Scientific Name)",
    koreanName: "국명 (Korean Name)",
    kingdom: "계 (Kingdom)",
    divisionPhylum: "문 (Division/Phylum)",
    class: "강 (Class)",
    order: "목 (Order)",
    family: "과 (Family)",
    genus: "속 (Genus)",
    collectionInfo: "2. 채집 정보 (Collection information)",
    collector: "채집자 (Collector)",
    collDate: "채집일 (Coll. Date)",
    collNo: "채집 번호 (Coll. No.)",
    determinationInfo: "3. 동정 정보 (Determination Information)",
    detBy: "동정자 (Det. by)",
    localityInfo: "4. 산지 정보 (Locality Information)",
    location: "지역 (Location)",
    specificLocality: "상세 지역 (Specific Locality)",
    habitatInfo: "서식지 정보 (Habitat Information)",
    latitude: "위도 (Latitude)",
    longitude: "경도 (Longitude)",
    altitudeDepth: "고도 / 수심 (Altitude / Depth)",
    specimenInfo: "5. 표본 정보 (Specimen information)",
    specimenName: "표본명 (Herbarium Specimen Name)",
    specimenNote: "표본 비고 (Herbarium Specimen Note)",
    list: "목록 (LIST)",
    edit: "수정 (Edit)",
    delete: "삭제 (Delete)",
    save: "저장 (Save)",
    cancel: "취소 (Cancel)",
    newRecord: "신규 표본 등록 (New Record)",
    viewRecord: "표본 상세 (Herbarium View)",
    photo: "표본 사진 (Specimen Photo)",
  }
} as const;

type Lang = keyof typeof t;
type PendingMutation = 'save' | 'delete' | null;

const parseDms = (str: string, defaultDir: string) => {
  if (!str) return { dir: defaultDir, deg: '', min: '', sec: '' };
  let clean = str.trim();
  let dir = defaultDir;

  const isLat = defaultDir === 'N' || defaultDir === 'S';

  // Check for negative sign indicating S or W
  if (clean.startsWith('-')) {
    dir = isLat ? 'S' : 'W';
    clean = clean.substring(1).trim();
  }

  // Check for [N]/[S]/[E]/[W] or N/S/E/W prefix or suffix
  const dirMatch = clean.match(/\[?([NSEWnsew])\]?/);
  if (dirMatch) {
    dir = dirMatch[1].toUpperCase();
  }

  // Check standard DMS: e.g. 78°11'16"
  const dmsMatch = clean.match(/(\d+)\s*°\s*(\d+)\s*['′]\s*(\d+(?:\.\d+)?)\s*["″]?/);
  if (dmsMatch) {
    return { dir, deg: dmsMatch[1], min: dmsMatch[2], sec: dmsMatch[3] };
  }

  // Alternate match for just deg min sec numbers
  const numMatch = clean.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+(?:\.\d+)?)/);
  if (numMatch) {
    return { dir, deg: numMatch[1], min: numMatch[2], sec: numMatch[3] };
  }

  // Decimal degree format: e.g. 37.5665
  const decimalVal = parseFloat(clean);
  if (!isNaN(decimalVal)) {
    const absVal = Math.abs(decimalVal);
    const d = Math.floor(absVal);
    const minFloat = (absVal - d) * 60;
    const m = Math.floor(minFloat);
    const s = Math.round((minFloat - m) * 60 * 10) / 10;
    return { dir, deg: String(d), min: String(m), sec: String(s) };
  }

  return { dir, deg: '', min: '', sec: '' };
};

const CoordinateField = ({ label, name, value, isEditing, onChange, isLat = true }: any) => {
  const defaultDir = isLat ? 'N' : 'E';
  const dirs = isLat ? ['N', 'S'] : ['E', 'W'];
  const parsed = parseDms(value, defaultDir);

  const handleSubChange = (field: 'dir' | 'deg' | 'min' | 'sec', val: string) => {
    const next = { ...parsed, [field]: val };
    const deg = next.deg.trim();
    const min = next.min.trim();
    const sec = next.sec.trim();
    
    if (!deg && !min && !sec) {
      onChange({ target: { name, value: '' } });
      return;
    }
    
    // Format: 78°11'16" (or [N]78°11'16" if dir included)
    const formatted = `${deg || '0'}°${min || '0'}'${sec || '0'}"`;
    onChange({ target: { name, value: formatted } });
  };

  return (
    <div className="flex flex-col md:flex-row md:items-center py-3 border-b border-gray-200 last:border-0">
      <label className="text-sm font-semibold text-gray-700 w-full md:w-1/3 mb-1 md:mb-0 shrink-0">{label}</label>
      <div className="w-full md:w-2/3">
        {isEditing ? (
          <div className="flex items-center space-x-1.5 flex-wrap sm:flex-nowrap">
            <div className="flex items-center space-x-1 bg-white border border-gray-300 rounded-md px-2 py-1 focus-within:ring-2 focus-within:ring-emerald-500">
              <input
                type="number"
                min="0"
                max={isLat ? "90" : "180"}
                placeholder="00"
                value={parsed.deg}
                onChange={(e) => handleSubChange('deg', e.target.value)}
                className="w-12 text-center text-sm font-mono focus:outline-none bg-transparent"
              />
              <span className="text-gray-500 font-bold text-sm">°</span>
              <input
                type="number"
                min="0"
                max="59"
                placeholder="00"
                value={parsed.min}
                onChange={(e) => handleSubChange('min', e.target.value)}
                className="w-10 text-center text-sm font-mono focus:outline-none bg-transparent"
              />
              <span className="text-gray-500 font-bold text-sm">'</span>
              <input
                type="number"
                min="0"
                max="59"
                step="any"
                placeholder="00"
                value={parsed.sec}
                onChange={(e) => handleSubChange('sec', e.target.value)}
                className="w-12 text-center text-sm font-mono focus:outline-none bg-transparent"
              />
              <span className="text-gray-500 font-bold text-sm">"</span>
            </div>
            <span className="text-xs text-gray-400 font-mono hidden sm:inline">
              {value ? `(${value})` : `(예: ${isLat ? "78°11'16\"" : "15°45'20\""})`}
            </span>
          </div>
        ) : (
          <p className="text-gray-900 text-sm font-mono">{value || '-'}</p>
        )}
      </div>
    </div>
  );
};

const Field = ({ label, name, value, isEditing, onChange, type = "text", options, suggestions }: any) => (
  <div className="flex flex-col md:flex-row md:items-center py-3 border-b border-gray-200 last:border-0">
    <label className="text-sm font-semibold text-gray-700 w-full md:w-1/3 mb-1 md:mb-0 shrink-0">{label}</label>
    <div className="w-full md:w-2/3">
      {isEditing ? (
        options ? (
          <select 
            name={name} 
            value={value || ''} 
            onChange={onChange}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm bg-white"
          >
            {options.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        ) : (
          <>
            <input 
              type={type}
              name={name} 
              value={value || ''} 
              onChange={onChange}
              list={suggestions ? `${name}-suggestions` : undefined}
              autoComplete="off"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm bg-white"
            />
            {suggestions && (
              <datalist id={`${name}-suggestions`}>
                {suggestions.map((s: string) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </>
        )
      ) : (
        <p className="text-gray-900 text-sm">{value || '-'}</p>
      )}
    </div>
  </div>
);

export default function HerbariumDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  
  const isNew = id === undefined;
  
  const [record, setRecord] = useState<Partial<HerbariumRecord>>({
    type: 'Plant',
    scientificName: '',
    koreanName: '',
    kingdom: '',
    divisionPhylum: '',
    taxonomicClass: '',
    order: '',
    family: '',
    genus: '',
    collector: '',
    collDate: '',
    collectionNo: isNew ? 'INCH-PT00000' : '',
    detBy: '',
    location: '',
    specificLocality: '',
    habitatInformation: '',
    latitude: '',
    longitude: '',
    altitudeDepth: '',
    specimenName: '',
    specimenNote: '',
  });
  const [originalRecord, setOriginalRecord] = useState<Partial<HerbariumRecord> | null>(null);
  const [isEditing, setIsEditing] = useState(isNew);
  const [lang, setLang] = useState<Lang>('en');
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState('');
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | undefined>(undefined);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const labelRef = useRef<HTMLDivElement>(null);

  const [pendingMutation, setPendingMutation] = useState<PendingMutation>(null);

  const handleDownloadLabel = async () => {
    if (!labelRef.current) return;
    try {
      const canvas = await html2canvas(labelRef.current, { scale: 3, useCORS: true });
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `label-${record.id || 'new'}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Failed to download label:', err);
    }
  };

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (cooldownRemaining > 0) {
      timer = setTimeout(() => {
        setCooldownRemaining(prev => prev - 1);
      }, 1000);
    }
    return () => clearTimeout(timer);
  }, [cooldownRemaining]);

  useEffect(() => {
    if (!isNew && id) {
      getRecordById(id)
        .then(data => {
          if (!data) throw new Error('Record not found');
          setRecord(data);
          setOriginalRecord(data);
          setOriginalImageUrl(data.image);
          setLoading(false);
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    }
  }, [id, isNew]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecord(prev => {
      const next = { ...prev, [name]: value };
      if (name === 'collectionNo') {
        next.id = value; // Sync ID
      }
      return next;
    });
  };

  const executeSave = async (sessionToken: string) => {
    if (isSaving || cooldownRemaining > 0) return;
    setIsSaving(true);
    try {
      setError('');
      
      // Client-side validation
      const targetId = record.collectionNo;
      if (!/^INCH-PT\d{5}$/.test(targetId || '')) {
        throw new Error("ID (Coll. No.) must be exactly 'INCH-PT' followed by 5 digits (e.g. INCH-PT00000).");
      }
      
      if (!record.id) {
        record.id = targetId;
      }
      
      // Image upload via proxy to R2
      let imageUrl = record.image;
      if (selectedImageFile) {
        const formData = new FormData();
        formData.append('image', selectedImageFile);
        
        const uploadRes = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionToken}` },
          body: formData,
        });
        
        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to upload image to R2');
        }
        
        const uploadData = await uploadRes.json();
        imageUrl = uploadData.url;
      } else if (!record.image) {
        imageUrl = undefined;
      }

      if (originalImageUrl && originalImageUrl !== imageUrl && !originalImageUrl.startsWith('data:')) {
        await fetch('/api/delete-image', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ imageUrl: originalImageUrl })
        }).catch(err => console.error("Failed to delete old image", err));
      }
      
      const recordToSave = { ...record, image: imageUrl } as HerbariumRecord;
      
      await saveRecord(recordToSave);
      setOriginalImageUrl(imageUrl);
      
      // If collection number changed on an existing record, clean up the old document to prevent orphaned records
      if (!isNew && id && recordToSave.id !== id) {
        await deleteRecord(id).catch(err => console.error("Failed to cleanup old record ID", err));
      }

      if (isNew || recordToSave.id !== id) {
        navigate(`/data/${recordToSave.id}`, { replace: true });
        setIsEditing(false);
        setRecord(recordToSave);
        setOriginalRecord(recordToSave);
      } else {
        setRecord(recordToSave);
        setOriginalRecord(recordToSave);
        setIsEditing(false);
      }
      setSelectedImageFile(null);
      setCooldownRemaining(20);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => {
    if (isSaving || cooldownRemaining > 0) return;
    setError('');
    
    // Client-side validation before asking for OTP
    const targetId = record.collectionNo;
    if (!/^INCH-PT\d{5}$/.test(targetId || '')) {
      setError("ID (Coll. No.) must be exactly 'INCH-PT' followed by 5 digits (e.g. INCH-PT00000).");
      return;
    }

    // Authentication happens immediately before every Firestore/R2 mutation.
    setPendingMutation('save');
  };

  const executeDelete = async (sessionToken: string) => {
    if (!id || isDeleting) return;
    setIsDeleting(true);
    
    try {
      setError('');
      if (originalImageUrl && !originalImageUrl.startsWith('data:')) {
        await fetch('/api/delete-image', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ imageUrl: originalImageUrl })
        }).catch(err => console.error("Failed to delete image", err));
      }
      await deleteRecord(id);
      navigate('/data');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMutationAuthorized = (_username?: string, sessionToken?: string) => {
    const authorizedMutation = pendingMutation;
    setPendingMutation(null);

    if (!sessionToken) {
      setError(lang === 'ko' ? '인증 토큰을 발급받지 못했습니다. 다시 시도해주세요.' : 'No authorization token was issued. Please try again.');
      return;
    }

    if (authorizedMutation === 'save') {
      void executeSave(sessionToken);
    } else if (authorizedMutation === 'delete') {
      void executeDelete(sessionToken);
    }
  };

  const mutationAuthTitle = pendingMutation === 'delete'
    ? (lang === 'ko' ? '표본 삭제 OTP 인증' : 'Delete Specimen OTP Verification')
    : isNew
      ? (lang === 'ko' ? '신규 표본 등록 OTP 인증' : 'New Specimen Registration OTP Verification')
      : (lang === 'ko' ? '표본 수정 OTP 인증' : 'Edit Specimen OTP Verification');

  const mutationAuthDescription = pendingMutation === 'delete'
    ? (lang === 'ko'
        ? '이 표본을 삭제하려면 등록된 6자리 OTP 인증 코드를 입력해주세요.'
        : 'Enter a registered 6-digit OTP code to delete this specimen.')
    : isNew
      ? (lang === 'ko'
          ? '새 식물 표본을 저장하려면 등록된 6자리 OTP 인증 코드를 입력해주세요.'
          : 'Enter a registered 6-digit OTP code to save this new specimen.')
      : (lang === 'ko'
          ? '수정한 표본을 저장하려면 등록된 6자리 OTP 인증 코드를 입력해주세요.'
          : 'Enter a registered 6-digit OTP code to save these changes.');

  if (loading) return <div className="flex-1 flex justify-center py-12"><div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div></div>;
  
  if (error && !isNew && !originalRecord) return (
    <div className="flex-1 bg-white p-8 rounded-lg shadow-sm border border-red-200">
      <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
      <p className="text-gray-700">{error}</p>
      <button onClick={() => navigate('/data')} className="mt-4 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700 font-medium transition-colors">
        Back to List
      </button>
    </div>
  );

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center">
          <button 
            onClick={() => navigate('/data')}
            className="mr-4 p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded-full transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            {isNew ? t[lang].newRecord : `${t[lang].viewRecord}: ${record.id || ''}`}
          </h1>
        </div>
        
        <div className="flex space-x-3">
          {!isNew && !isEditing && (
            <>
              <button 
                onClick={() => setIsEditing(true)}
                className="flex items-center px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Edit2 className="w-4 h-4 mr-2" />
                {t[lang].edit}
              </button>
            </>
          )}
          {isEditing && (
            <>
              {!isNew && (
                <button 
                  onClick={() => {
                    if (originalRecord) {
                      setRecord(originalRecord);
                      setOriginalImageUrl(originalRecord.image);
                    }
                    setSelectedImageFile(null);
                    setError('');
                    setIsEditing(false);
                  }}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {t[lang].cancel}
                </button>
              )}
              <button 
                onClick={handleSave}
                disabled={isSaving || cooldownRemaining > 0}
                className={`flex items-center px-4 py-2 rounded-md text-sm font-medium text-white shadow-sm transition-colors ${
                  isSaving || cooldownRemaining > 0
                    ? 'bg-emerald-400 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                <Save className="w-4 h-4 mr-2" />
                {cooldownRemaining > 0 ? `${t[lang].save} (${cooldownRemaining}s)` : t[lang].save}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Full-screen loading overlay */}
      {(isSaving || isDeleting) && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white/70 backdrop-blur-[1px]">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-emerald-800 font-bold text-lg">{isDeleting ? 'Deleting...' : 'Saving...'}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-6">
        {/* Section 1 */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-bold text-emerald-800 mb-4 pb-2 border-b-2 border-emerald-100 inline-block">{t[lang].taxonomicInfo}</h2>
          <div className="bg-gray-50/50 p-4 rounded-md border border-gray-100">
            <Field label={t[lang].commonTaxon} name="type" value={record.type} isEditing={isEditing} onChange={handleChange} options={['Plant']} />
            <Field label={t[lang].scientificName} name="scientificName" value={record.scientificName} isEditing={isEditing} onChange={handleChange} suggestions={scientificNameSuggestions} />
            <Field label={t[lang].koreanName} name="koreanName" value={record.koreanName} isEditing={isEditing} onChange={handleChange} suggestions={koreanNameSuggestions} />
            <Field label={t[lang].kingdom} name="kingdom" value={record.kingdom} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].divisionPhylum} name="divisionPhylum" value={record.divisionPhylum} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].class} name="taxonomicClass" value={record.taxonomicClass} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].order} name="order" value={record.order} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].family} name="family" value={record.family} isEditing={isEditing} onChange={handleChange} suggestions={familySuggestions} />
            <Field label={t[lang].genus} name="genus" value={record.genus} isEditing={isEditing} onChange={handleChange} />
          </div>
        </div>

        {/* Section 2 */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-bold text-emerald-800 mb-4 pb-2 border-b-2 border-emerald-100 inline-block">{t[lang].collectionInfo}</h2>
          <div className="bg-gray-50/50 p-4 rounded-md border border-gray-100">
            <Field label={t[lang].collector} name="collector" value={record.collector} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].collDate} name="collDate" value={record.collDate} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].collNo} name="collectionNo" value={record.collectionNo} isEditing={isEditing} onChange={handleChange} />
          </div>
        </div>

        {/* Section 3 */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-bold text-emerald-800 mb-4 pb-2 border-b-2 border-emerald-100 inline-block">{t[lang].determinationInfo}</h2>
          <div className="bg-gray-50/50 p-4 rounded-md border border-gray-100">
            <Field label={t[lang].detBy} name="detBy" value={record.detBy} isEditing={isEditing} onChange={handleChange} />
          </div>
        </div>

        {/* Section 4 */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-bold text-emerald-800 mb-4 pb-2 border-b-2 border-emerald-100 inline-block">{t[lang].localityInfo}</h2>
          <div className="bg-gray-50/50 p-4 rounded-md border border-gray-100">
            <Field label={t[lang].location} name="location" value={record.location} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].specificLocality} name="specificLocality" value={record.specificLocality} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].habitatInfo} name="habitatInformation" value={record.habitatInformation} isEditing={isEditing} onChange={handleChange} />
            <CoordinateField label={t[lang].latitude} name="latitude" value={record.latitude} isEditing={isEditing} onChange={handleChange} isLat={true} />
            <CoordinateField label={t[lang].longitude} name="longitude" value={record.longitude} isEditing={isEditing} onChange={handleChange} isLat={false} />
            <Field label={t[lang].altitudeDepth} name="altitudeDepth" value={record.altitudeDepth} isEditing={isEditing} onChange={handleChange} />
          </div>
        </div>

        {/* Section 5 */}
        <div className="p-6">
          <h2 className="text-lg font-bold text-emerald-800 mb-4 pb-2 border-b-2 border-emerald-100 inline-block">{t[lang].specimenInfo}</h2>
          <div className="bg-gray-50/50 p-4 rounded-md border border-gray-100">
            
            {/* Image Placeholder Box */}
            <div className="mb-6 flex flex-col items-center justify-center w-full max-w-sm relative">
              {isEditing ? (
                <>
                  <label className="w-full flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg bg-white py-8 cursor-pointer hover:bg-gray-50 transition-colors">
                    <ImageIcon className="w-10 h-10 mb-2 text-gray-400" />
                    <span className="text-sm text-gray-600">{record.image ? 'Change Photo' : 'Upload Photo'}</span>
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setSelectedImageFile(file);
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setRecord(prev => ({ ...prev, image: reader.result as string }));
                        };
                        reader.readAsDataURL(file);
                      }
                    }} />
                  </label>
                  {record.image && (
                    <button 
                      type="button" 
                      onClick={() => {
                        setSelectedImageFile(null);
                        setRecord(prev => ({ ...prev, image: undefined }));
                      }}
                      className="mt-2 text-sm text-red-500 font-medium hover:text-red-700 transition-colors"
                    >
                      Remove Photo
                    </button>
                  )}
                </>
              ) : null}
              {record.image ? (
                <img 
                  src={record.image.startsWith('http') || record.image.startsWith('/') || record.image.startsWith('data:') ? record.image : `https://${record.image}`} 
                  alt="Specimen" 
                  referrerPolicy="no-referrer" 
                  className="w-full h-auto rounded-lg shadow-sm border border-gray-200 mt-2" 
                />
              ) : !isEditing ? (
                <div className="w-full border-2 border-dashed border-gray-200 rounded-lg bg-gray-50 py-12 flex flex-col items-center justify-center text-gray-400">
                   <ImageIcon className="w-12 h-12 mb-3 text-gray-300" />
                   <span className="text-sm">{t[lang].photo}</span>
                </div>
              ) : null}
            </div>

            <Field label={t[lang].specimenName} name="specimenName" value={record.specimenName} isEditing={isEditing} onChange={handleChange} />
            <Field label={t[lang].specimenNote} name="specimenNote" value={record.specimenNote} isEditing={isEditing} onChange={handleChange} />
          </div>
        </div>
      </div>
      
      <div className="flex justify-between items-center mb-8">
        <button
          onClick={() => setLang(l => l === 'en' ? 'ko' : 'en')}
          className="flex items-center px-4 py-2 border border-emerald-200 text-emerald-700 bg-emerald-50 rounded-md hover:bg-emerald-100 transition-colors font-medium text-sm"
        >
          <Languages className="w-4 h-4 mr-2" />
          {lang === 'en' ? '한국어 번역 보기' : 'Show English'}
        </button>

        <div className="flex space-x-3">
          {!isEditing && !isNew && (
            <button 
              onClick={handleDownloadLabel}
              className="flex items-center px-4 py-2.5 bg-blue-50 text-blue-700 border border-blue-200 font-medium rounded-md hover:bg-blue-100 transition-colors shadow-sm"
            >
              <Download className="w-4 h-4 mr-2" />
              라벨지 다운로드
            </button>
          )}
          {isEditing && !isNew && (
            <button 
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center px-4 py-2.5 bg-red-50 text-red-600 border border-red-200 font-medium rounded-md hover:bg-red-100 transition-colors shadow-sm"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t[lang].delete}
            </button>
          )}
          <button 
            onClick={() => navigate('/data')}
            className="px-6 py-2.5 bg-gray-800 text-white font-medium rounded-md hover:bg-gray-900 transition-colors shadow-sm"
          >
            {t[lang].list}
          </button>
        </div>
      </div>

      {/* Custom Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Delete Record</h3>
            <p className="text-gray-600 mb-6 text-sm">Are you sure you want to delete this record? This action cannot be undone.</p>
            <div className="flex justify-end space-x-3">
              <button 
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 font-medium transition-colors text-sm"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setPendingMutation('delete');
                }}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium transition-colors text-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden Label Template for Download */}
      <div className="absolute top-0 left-0 -z-50 opacity-0 pointer-events-none">
        <div 
          ref={labelRef} 
          style={{
            width: '100mm',
            height: '100mm',
            border: '1px solid #000',
            padding: '8mm', // 여백을 약간 늘려 안정감 부여
            fontFamily: '"Times New Roman", Times, serif',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between', // 큰 구역(상/중/하) 간의 간격만 벌림
            backgroundColor: '#fff',
            color: '#000',
          }}
        >
          {/* --- [상단 구역] --- */}
          <div>
            {/* 1행: 상단 문구 (중앙 정렬) 및 로고 (우측 절대배치) */}
            <div style={{ position: 'relative', textAlign: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '13pt', fontWeight: 'bold', lineHeight: '1.2' }}>
                Flora of GEC<br/>The Virtual Herbarium
              </div>
              <img 
                src="/api/proxy-logo" 
                alt="Logo" 
                style={{ position: 'absolute', top: 0, right: 0, height: '10mm', objectFit: 'contain' }} 
                crossOrigin="anonymous"
              />
            </div>

            {/* 2행: ID 및 과명 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11pt', borderBottom: '1px solid #000', paddingBottom: '6px' }}>
              <span style={{ fontWeight: 'bold' }}>{record?.id || 'N/A'}</span>
              <span style={{ fontWeight: 'bold', textTransform: 'uppercase' }}>{record?.family || 'N/A'}</span>
            </div>
          </div>

          {/* --- [중단 구역] --- */}
          {/* 3행: 학명 */}
          <div style={{ 
            fontSize: '20pt', 
            fontWeight: 'bold', 
            fontStyle: 'italic', 
            textAlign: 'center', 
            margin: '12px 0' 
          }}>
            {record?.scientificName || 'Unknown Species'}
          </div>

          {/* --- [하단 구역] --- */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            
            {/* 4~6행: 채집지 정보 */}
            <div style={{ fontSize: '11pt', lineHeight: '1.4' }}>
              <div>{[record?.location, record?.specificLocality].filter(Boolean).join(' ') || 'N/A'}</div>
              <div>Habitat: {record?.habitatInformation || record?.specimenNote || '-'}</div>
              <div>
                {record?.latitude ? `${record.latitude} N` : 'N/A'}, {record?.longitude ? `${record.longitude} E` : 'N/A'}
              </div>
            </div>

            {/* 7~9행: 메타데이터 */}
            <div style={{ fontSize: '11pt', lineHeight: '1.4', marginTop: '14px' }}>
              <div style={{ display: 'flex' }}>
                <span style={{ fontWeight: 'bold', width: '16mm' }}>Date:</span>
                <span>
                  {record?.collDate ? (
                    record.collDate.split('~').map(d => d.trim()).reduce((a, b) => a === b ? a : `${a} ~ ${b}`)
                  ) : '-'}
                </span>
              </div>
              <div style={{ display: 'flex' }}>
                <span style={{ fontWeight: 'bold', width: '16mm' }}>Coll.:</span>
                <span>
                  {record?.collector || '-'} 
                  {(record?.collectionNo || record?.id) ? ` (${record?.collectionNo || record?.id})` : ''}
                </span>
              </div>
              <div style={{ display: 'flex' }}>
                <span style={{ fontWeight: 'bold', width: '16mm' }}>Det.:</span>
                <span>{record?.detBy || '-'}</span>
              </div>
            </div>

          </div>
        </div>
      </div>

      {pendingMutation && (
        <TotpAuth 
          lang={lang} 
          title={mutationAuthTitle}
          description={mutationAuthDescription}
          onSuccess={handleMutationAuthorized}
          onCancel={() => setPendingMutation(null)}
        />
      )}

    </div>
  );
}

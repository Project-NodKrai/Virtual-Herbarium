import fs from 'fs';
const data = fs.readFileSync('./species_data.csv.csv', 'utf8');
const lines = data.split('\n').slice(1).filter(l => l.trim().length > 0);
const species = lines.map(line => {
  const parts = line.split(',');
  return {
    koreanName: parts[1]?.trim(),
    scientificName: parts[11]?.trim()
  };
}).filter(s => s.koreanName || s.scientificName);
console.log(species.slice(0, 5));

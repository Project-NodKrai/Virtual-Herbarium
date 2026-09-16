import fs from 'fs';
const data = fs.readFileSync('src/components/family_data.csv', 'utf8');
const lines = data.split('\n').slice(1).filter(l => l.trim().length > 0);
const families = lines.map(line => {
  const parts = line.split(',');
  return { family: parts[1], koreanName: parts[2] };
});
console.log(families.slice(0, 5));

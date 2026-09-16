export interface HerbariumRecord {
  id: string;
  type: string;
  scientificName: string;
  koreanName: string;
  kingdom: string;
  divisionPhylum: string;
  taxonomicClass: string;
  order: string;
  family: string;
  genus: string;
  collector: string;
  collDate: string;
  collectionNo: string;
  detBy: string;
  location: string;
  specificLocality: string;
  habitatInformation: string;
  latitude: string;
  longitude: string;
  altitudeDepth: string;
  specimenName: string;
  specimenNote: string;
  image?: string;
}

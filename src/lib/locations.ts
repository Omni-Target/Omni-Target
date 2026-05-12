export const LAGOS_AREAS = [
  "ikoyi", "lekki", "victoria island",
  "vi", "surulere", "yaba", "ikeja",
  "ajah", "festac", "gbagada", 
  "maryland", "mushin", "agege",
  "isale eko", "lagos island",
  "apapa", "magodo", "ojodu",
  "ojota", "oshodi", "palmgrove"
];

export const ABUJA_AREAS = [
  "maitama", "wuse", "garki", "asokoro",
  "gwarinpa", "kubwa", "lugbe", "jabi",
  "utako", "gudu", "life camp"
];

export const PH_AREAS = [
  "gra port harcourt", "trans amadi",
  "rumuola", "rumuokoro", "eleme"
];

export function consolidateLocation(city: string): string {
  if (!city) return "Unknown";
  const cityLower = city.toLowerCase().trim();
  
  if (LAGOS_AREAS.includes(cityLower) || cityLower === "lagos") {
    return "Lagos";
  }
  if (ABUJA_AREAS.includes(cityLower) || cityLower === "abuja") {
    return "Abuja";
  }
  if (PH_AREAS.includes(cityLower) || cityLower.includes("port harcourt") || cityLower === "ph") {
    return "Port Harcourt";
  }
  
  return city;
}

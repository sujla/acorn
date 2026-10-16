// Acorn-owned, revision-checked compatibility rule. It changes only the isolated
// preview transform, never project files, Platform.OS, API keys or Expo config.
const guard = 'const hasKey = Constants.expoConfig?.extra?.googleMapsConfigured?.[Platform.OS] === true;';
function mapCompatibility(filename, source) {
  const match = /(?:^|[\\/])src[\\/]components[\\/]map[\\/]GoogleTransitMap\.tsx$/.test(filename)
    && source.includes("from 'react-native-maps'")
    && source.includes('GoogleTransitMap = forwardRef')
    && source.includes(guard)
    && source.includes('if (!hasKey) return');
  return { applied: match, source: match ? source.replace(guard, 'const hasKey = true; // Acorn schematic map adapter; no Google SDK or API key is used.') : source };
}
module.exports = { mapCompatibility };

import restricted from "../../../../country-packs/packs/restricted.json";
const codes = new Set(restricted.places.map((p) => p.code));
/** Defensive display guard using the authoritative data, not a second policy list or authorization check. */
export function selectableTerritories(territories: readonly string[]): boolean {
  return (
    territories.length > 0 &&
    territories.every((raw) => {
      const code = raw.trim().toUpperCase();
      return (
        /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(code) &&
        !codes.has(code) &&
        !codes.has(code.split("-")[0]!)
      );
    })
  );
}

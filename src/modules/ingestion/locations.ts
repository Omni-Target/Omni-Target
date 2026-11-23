import type { Gql } from "./bulk";
import { mapLocation, type LocationRow } from "./mappers";
import { LOCATIONS_QUERY } from "./queries";

/** Every location of the shop, inactive ones included (at most 40 pages of 250). */
export async function fetchLocations(gql: Gql, maxPages = 40): Promise<LocationRow[]> {
  const locations: LocationRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: { locations: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(LOCATIONS_QUERY, { after });
    locations.push(...data.locations.nodes.map(mapLocation).filter((l): l is LocationRow => l !== null));
    if (!data.locations.pageInfo.hasNextPage) return locations;
    after = data.locations.pageInfo.endCursor;
  }
  throw new Error(`locations: more than ${maxPages} pages`);
}

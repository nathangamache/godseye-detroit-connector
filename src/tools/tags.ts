/**
 * Hand-written search tags/synonyms and attribution lines per tool. Tags feed
 * the BM25 index used by find_tools; attribution is appended to run_tool output.
 */
export interface ToolMeta {
  tags: string[];
  attribution?: string;
}

/** find_tools catalog categories, in display order. "other" holds anything uncategorised. */
export const CATEGORIES = [
  { id: 'rail', label: 'Rail lines, crossings and rail radio' },
  { id: 'scanner', label: 'Scanner radio and incidents (Detroit Pulse)' },
  { id: 'weather', label: 'Weather, radar and wind' },
  { id: 'hazards', label: 'Earthquakes, fires, storms and floods' },
  { id: 'traffic', label: 'Traffic, routes and transit' },
  { id: 'cameras', label: 'Public cameras' },
  { id: 'aviation', label: 'Aircraft' },
  { id: 'maritime', label: 'Ships and vessels' },
  { id: 'space', label: 'Satellites, launches and imagery' },
  { id: 'news', label: 'News, radio stations and briefs' },
  { id: 'places', label: 'Places, terrain and infrastructure' },
  { id: 'map', label: "God's Eye View map links" },
  { id: 'other', label: 'Other' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];

const CATEGORY_OF: Record<string, CategoryId> = {
  nearest_rail: 'rail',
  crossings_near: 'rail',
  rail_activity_near: 'rail',
  incidents_near: 'scanner',
  incident_detail: 'scanner',
  search_transcripts: 'scanner',
  feeds_status: 'scanner',
  dpd_calls_near: 'scanner',
  get_weather: 'weather',
  get_weather_map: 'weather',
  get_wind: 'weather',
  get_earthquakes: 'hazards',
  get_active_fires: 'hazards',
  get_fire_perimeters: 'hazards',
  get_cyclones: 'hazards',
  get_bhote_koshi_flood: 'hazards',
  get_traffic_flow: 'traffic',
  plan_route: 'traffic',
  get_transit_vehicles: 'traffic',
  transit_vehicles_near: 'traffic',
  get_bike_share: 'traffic',
  find_cctv_cameras: 'cameras',
  get_cctv_snapshot: 'cameras',
  find_alpr_cameras: 'cameras',
  aircraft_in_area: 'aviation',
  find_aircraft: 'aviation',
  get_aircraft_track: 'aviation',
  get_aircraft_info: 'aviation',
  vessels_in_area: 'maritime',
  find_vessel: 'maritime',
  get_vessel_track: 'maritime',
  get_recent_launches: 'space',
  next_satellite_pass: 'space',
  satellites_overhead: 'space',
  get_recent_imagery: 'space',
  get_regional_brief: 'news',
  local_headlines: 'news',
  find_radio_stations: 'news',
  situation_brief: 'news',
  military_awareness: 'news',
  get_hud_caption: 'news',
  get_map_features: 'places',
  get_terrain_height: 'places',
  find_infrastructure: 'places',
  find_submarine_cables: 'places',
  find_military_installations: 'places',
  search_places: 'places',
  places_nearby: 'places',
  show_in_gods_eye_view: 'map',
};

/** A tool's catalog category: hand-assigned, else by source (Pulse tools are scanner), else other. */
export function categoryFor(name: string, source?: string): CategoryId {
  return CATEGORY_OF[name] ?? (source === 'pulse' ? 'scanner' : 'other');
}

const OSM = '© OpenStreetMap contributors (ODbL), openstreetmap.org/copyright';
const OPEN_METEO = 'Weather data by Open-Meteo.com (CC BY 4.0)';
const NOAA = 'NOAA / NWS';
const FRA_NARN =
  'U.S. DOT FRA Grade Crossing Inventory and BTS/FRA North American Rail Network (NTAD), public domain';

export const TOOL_META: Record<string, ToolMeta> = {
  // --- gateway-native (rail; "pulse" family) ---
  nearest_rail: {
    tags: [
      'train',
      'trains',
      'railroad',
      'railway',
      'rail',
      'rail line',
      'track',
      'tracks',
      'crossing',
      'grade crossing',
      'level crossing',
      'freight',
      'locomotive',
      'subdivision',
      'railroad owner',
      'csx',
      'norfolk southern',
      'canadian national',
      'cn',
      'cpkc',
      'conrail',
      'amtrak',
      'nearest track',
      'blocked crossing',
      'train stopped',
    ],
    attribution: FRA_NARN,
  },
  crossings_near: {
    tags: [
      'list of grade crossings',
      'all crossings within radius',
      'gates',
      'fra crossing id',
      'dot number',
      'railroad',
    ],
    attribution: FRA_NARN,
  },
  // --- Pulse (scanner radio pipeline) ---
  incidents_near: {
    tags: [
      'incident',
      'incidents',
      'police',
      'fire',
      'ems',
      'ambulance',
      'emergency',
      'scanner',
      'dispatch',
      'crash',
      'accident',
      "what's happening",
      'nearby',
      'radio',
      'detroit pulse',
    ],
  },
  incident_detail: {
    tags: ['incident', 'details', 'transcript', 'units', 'timeline', 'scanner', 'dispatch'],
  },
  search_transcripts: {
    tags: [
      'transcript',
      'transcripts',
      'radio',
      'scanner',
      'search',
      'heard',
      'said',
      'dispatch',
      'channel',
    ],
  },
  rail_activity_near: {
    tags: [
      'train',
      'railroad radio',
      'rail radio',
      'defect detector',
      'detector',
      'eot',
      'end of train',
      'hot',
      'head of train',
      'dispatcher',
      'train stopped',
      'why is the train stopped',
      'freight',
      'locomotive',
      'crossing blocked',
      'rail',
      'railroad',
    ],
  },
  feeds_status: {
    tags: ['feeds', 'status', 'scanner feeds', 'coverage', 'pulse health', 'radio coverage'],
  },
  // --- GEV ---
  get_earthquakes: {
    tags: ['earthquake', 'quake', 'seismic', 'tremor', 'usgs', 'magnitude', 'shaking'],
    attribution: 'USGS',
  },
  get_active_fires: {
    tags: ['fire', 'wildfire', 'hotspot', 'burning', 'smoke', 'firms', 'blaze'],
    attribution: 'NASA FIRMS (LANCE/EOSDIS)',
  },
  get_recent_launches: {
    tags: ['rocket', 'launch', 'spacex', 'orbital', 'mission', 'space launch'],
    attribution: 'Launch Library 2 (The Space Devs)',
  },
  aircraft_in_area: {
    tags: [
      'aircraft',
      'plane',
      'planes',
      'flights',
      'helicopter',
      'overhead',
      'ads-b',
      'airspace',
      'police helicopter',
      'news chopper',
    ],
    attribution: 'OpenSky Network; adsb.lol contributors (ODbL)',
  },
  find_aircraft: {
    tags: ['flight lookup', 'callsign', 'tail number', 'registration', 'icao hex'],
    attribution: 'OpenSky Network; adsb.lol contributors (ODbL)',
  },
  get_aircraft_track: {
    tags: ['flight path', 'track', 'trail', 'flight history'],
    attribution: 'OpenSky Network; adsb.lol contributors (ODbL)',
  },
  get_aircraft_info: {
    tags: ['aircraft type', 'airline', 'route', 'origin', 'destination', 'what plane'],
    attribution: 'adsbdb',
  },
  vessels_in_area: {
    tags: [
      'ships',
      'boats',
      'vessels',
      'ais',
      'freighter',
      'marine traffic',
      'river',
      'detroit river',
    ],
    attribution: 'AISStream.io',
  },
  find_vessel: { tags: ['ship lookup', 'mmsi', 'imo', 'vessel name'], attribution: 'AISStream.io' },
  get_vessel_track: { tags: ['ship track', 'voyage', 'vessel path'], attribution: 'AISStream.io' },
  next_satellite_pass: {
    tags: ['iss', 'satellite pass', 'flyover', 'space station', 'visible'],
    attribution: 'CelesTrak',
  },
  satellites_overhead: {
    tags: ['satellites above', 'overhead now', 'starlink', 'gps sats'],
    attribution: 'CelesTrak',
  },
  find_cctv_cameras: {
    tags: [
      'camera',
      'cameras',
      'cctv',
      'webcam',
      'traffic cam',
      'live view',
      'dot camera',
      'road camera',
      'crossing camera',
    ],
    attribution: 'Camera operators as credited per camera',
  },
  get_cctv_snapshot: {
    tags: [
      'snapshot',
      'camera image',
      'photo',
      'picture',
      'live image',
      'frame',
      'what does it look like',
    ],
    attribution: 'Camera operator as credited',
  },
  find_alpr_cameras: {
    tags: ['alpr', 'license plate reader', 'flock', 'anpr', 'plate camera', 'surveillance'],
    attribution: OSM,
  },
  find_radio_stations: {
    tags: ['radio', 'stream', 'station', 'am', 'fm', 'news radio', 'scanner stream', 'listen'],
    attribution: 'Radio Browser',
  },
  search_places: {
    tags: ['search', 'find place', 'business', 'poi', 'address', 'landmark', 'where is'],
  },
  places_nearby: { tags: ['nearby', 'around me', "what's here", 'closest', 'points of interest'] },
  plan_route: {
    tags: [
      'route',
      'directions',
      'detour',
      'drive',
      'walk',
      'bike',
      'navigate',
      'eta',
      'way around',
    ],
    attribution: `Routing: OSRM on FOSSGIS servers; ${OSM}`,
  },
  get_bike_share: {
    tags: ['bike share', 'mogo', 'bikes', 'docks', 'gbfs', 'cycling'],
    attribution: 'GBFS feed operators',
  },
  // No ddot/smart/qline tags: GEV's registry has no Michigan feed (SMART is transit_vehicles_near).
  get_transit_vehicles: {
    tags: [
      'bus',
      'transit',
      'tram',
      'streetcar',
      'light rail',
      'gtfs',
      'realtime vehicles',
      'commuter rail',
    ],
    attribution: 'GTFS-realtime feed operators',
  },
  get_traffic_flow: {
    tags: [
      'traffic',
      'congestion',
      'jam',
      'backup',
      'slow',
      'road closure',
      'closed road',
      'speed',
      'delay',
      'gridlock',
      'tomtom',
    ],
    attribution: 'Traffic flow data © TomTom',
  },
  get_weather: {
    tags: [
      'weather',
      'temperature',
      'rain',
      'snow',
      'conditions',
      'visibility',
      'forecast',
      'cold',
      'hot',
    ],
    attribution: OPEN_METEO,
  },
  get_weather_map: {
    tags: ['radar', 'weather map', 'clouds', 'lightning', 'storm', 'precipitation'],
    attribution: `${NOAA} nowCOAST`,
  },
  get_wind: {
    tags: ['wind', 'gusts', 'wind direction', 'gfs', 'ecmwf'],
    attribution: 'NOAA GFS / ECMWF Open Data',
  },
  get_recent_imagery: {
    tags: ['satellite image', 'aerial', 'landsat', 'sentinel', 'overhead photo'],
    attribution: 'NASA HLS / VIIRS (Worldview)',
  },
  find_submarine_cables: {
    tags: ['undersea cable', 'submarine cable', 'landing point'],
    attribution: 'TeleGeography (CC BY-NC-SA 3.0)',
  },
  find_infrastructure: {
    tags: ['datacenter', 'data center', 'dam', 'reservoir', 'infrastructure'],
    attribution: OSM,
  },
  get_bhote_koshi_flood: { tags: ['nepal flood', 'bhote koshi', 'glof', 'outburst flood'] },
  get_regional_brief: {
    tags: ['news', 'headlines', 'local news', "what's going on", 'breaking', 'region'],
    attribution: 'Natural Earth; Open-Meteo; Google News RSS / GDELT (personal use)',
  },
  get_cyclones: {
    tags: ['hurricane', 'tropical storm', 'cyclone', 'typhoon', 'nhc'],
    attribution: 'NOAA NHC/CPHC',
  },
  get_fire_perimeters: {
    tags: ['fire perimeter', 'containment', 'acres', 'wfigs', 'wildfire boundary'],
    attribution: 'NIFC WFIGS',
  },
  get_terrain_height: {
    tags: ['elevation', 'altitude', 'height', 'terrain', 'sea level'],
    attribution: 'Re:Earth terrain',
  },
  find_military_installations: {
    tags: ['military base', 'air base', 'army', 'installation', 'selfridge'],
    attribution: OSM,
  },
  get_map_features: {
    tags: ['neighborhood', 'city', 'county', 'admin area', 'park', 'monument', 'what area'],
    attribution: OSM,
  },
  situation_brief: {
    tags: ['overview', 'situation', 'sitrep', 'summary'],
    attribution: 'Composite of GEV sources',
  },
  military_awareness: { tags: ['military', 'warships', 'military aircraft', 'bases nearby'] },
  get_hud_caption: { tags: ['caption', 'hud', 'headline'] },
  show_in_gods_eye_view: {
    tags: [
      'map',
      'show',
      'globe',
      'visualize',
      'open map',
      'link',
      '3d view',
      'display',
      'gods eye view',
    ],
  },
};

export function metaFor(name: string): ToolMeta {
  return TOOL_META[name] ?? { tags: [] };
}

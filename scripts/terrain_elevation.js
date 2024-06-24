/* globals
canvas,
PIXI,
ui
*/
"use strict";

/* When dragging tokens
Origin: each token elevation
Other: terrain elevation for each token
*/

/* When using ruler from a movement token
Origin: token elevation
Other:
 - Hovering over token: highest token elevation unless prefer token elevation
 - Otherwise: terrain elevation
*/

/* When using ruler without movement token_controls
Origin: terrain elevation
Other:
 - Hovering over token: highest token elevation unless prefer token elevation
 - terrain elevation
*/

/* Key methods
Ruler.terrainElevationAtLocation(location, { movementToken, startingElevation = 0 })
Ruler.prototype.elevationAtLocation(location, token)
Ruler.elevationAtWaypoint

Getters:
  - originElevation
  - destinationElevation

elevationAtLocation -- all ruler types
*/


/* Measure terrain elevation at a point.
Used by ruler to get elevation at waypoints and at the end of the ruler.
*/

import { MODULES_ACTIVE, MOVEMENT_TYPES } from "./const.js";
import { Settings } from "./settings.js";

/**
 * Calculate the elevation for a given waypoint.
 * Terrain elevation + user increment
 * @param {object} waypoint
 * @returns {number}
 */
export function elevationAtWaypoint(waypoint) {
  const incr = waypoint._userElevationIncrements ?? 0;
  const terrainE = waypoint._terrainElevation ?? 0;
  return terrainE + (incr * canvas.dimensions.distance);
}

/**
 * Add getter Ruler.prototype.originElevation
 * Retrieve the elevation at the current ruler origin waypoint.
 * @returns {number|undefined} Elevation, in grid units. Undefined if the ruler has no waypoints.
 */
export function originElevation() {
  const firstWaypoint = this.waypoints[0];
  return firstWaypoint ? elevationAtWaypoint(firstWaypoint) : undefined;
}

/**
 * Retrieve the terrain elevation at the current ruler destination
 * @param {object} [options]  Options that modify the calculation
 * @param {boolean} [options.considerTokens]    Consider token elevations at that point.
 * @returns {number|undefined} Elevation, in grid units. Undefined if ruler not active.
 */
export function destinationElevation() {
  if ( !this.destination ) return undefined;
  return this.elevationAtLocation(this.destination);
}

/**
 * Ruler.terrainElevationAtLocation
 * Measure elevation at a given location. Terrain level: at or below this elevation.
 * @param {Point} location      Location to measure
 * @param {object} [opts]       Options that modify the calculation
 * @param {number} [opts.fixedElevation]        Any area that contains this elevation counts
 * @param {number} [opts.maxElevation]          Any area below or equal to this grid elevation counts
 * @param {Token} [opts.movementToken]          Assumed token for the measurement. Relevant for EV.
 * @returns {number} Elevation, in grid units.
 */
export function terrainElevationAtLocation(location, { maxElevation, fixedElevation, movementToken } = {}) {
  maxElevation ??= movementToken?.elevationE ?? 0;

  // If certain modules are active, use them to calculate elevation.
  // For now, take the first one that is present.
  const tmRes = TMElevationAtPoint(location, { fixedElevation: fixedElevation ?? maxElevation });
  if ( isFinite(tmRes) ) return tmRes;

  const levelsRes = LevelsElevationAtPoint(location, maxElevation);
  if ( isFinite(levelsRes) ) return levelsRes;

  // Default is the scene elevation.
  return 0;
}

/**
 * Ruler.prototype.elevationAtLocation.
 * Measure elevation for a given ruler position and token,
 * accounting for straight-line movement from prior waypoint to location
 * Accounts for whether we are using regular Ruler or Token Ruler.
 * @param {Point} location      Position on canvas to measure
 * @param {Token} [token]       Token that is assumed to be moving if not this._movementToken
 * @returns {number}
 */
export function elevationAtLocation(location, token) {
  location = PIXI.Point.fromObject(location);
  token ??= this.token;
  const isTokenRuler = Settings.get(Settings.KEYS.TOKEN_RULER.ENABLED)
    && ui.controls.activeControl === "token"
    && ui.controls.activeTool === "select"
    && token;

  // For debugging, test at certain distance
  const dist = CONFIG.GeometryLib.utils.pixelsToGridUnits(PIXI.Point.distanceBetween(this.waypoints.at(-1), location));
  if ( dist > 5 ) console.debug(`elevationAtLocation ${dist}`);
  if ( dist > 10 ) console.debug(`elevationAtLocation ${dist}`);
  if ( dist > 20 ) console.debug(`elevationAtLocation ${dist}`);
  if ( dist > 30 ) console.debug(`elevationAtLocation ${dist}`);
  if ( dist > 40 ) console.debug(`elevationAtLocation ${dist}`);



  // For normal ruler, if hovering over a token, use that token's elevation.
  if ( !isTokenRuler && !Settings.FORCE_TO_GROUND ) {
    // Check for other tokens at destination and use that elevation.
    const maxTokenE = retrieveVisibleTokens()
      .filter(t => t.constrainedTokenBorder.contains(location.x, location.y))
      .reduce((e, t) => Math.max(t.elevationE, e), Number.NEGATIVE_INFINITY);
    if ( isFinite(maxTokenE) ) return maxTokenE;
  }

  let startElevation = this.originElevation;

  // If no token present, then this is a straight measurement
  if ( !token ) return startElevation;

  let endElevation = startElevation;
  const prevWaypoint = this.waypoints.at(-1);
  if ( !prevWaypoint ) return startElevation; // Shouldn't happen.

  // Either ruler with an origin token or Token Ruler
  // If at ruler origin (single waypoint):
  // - If walking: use the terrain elevation
  // - Not walking: use the token elevation
  // Destination elevation is the terrain elevation if walking
  const isWalking = token.movementType === "WALK" || Settings.FORCE_TO_GROUND;
  if ( this.waypoints.length === 1 ) { // First waypoint is the token origin.
    startElevation = isWalking ? this.constructor.terrainElevationAtLocation(prevWaypoint,
        { movementToken: token, maxElevation: startElevation }) : token.elevationE;

    // User can affect the starting elevation.
    startElevation += (prevWaypoint._userElevationIncrements ?? 0) * canvas.dimensions.distance;
  } else endElevation = isWalking ? this.constructor.terrainElevationAtLocation(location,
        { movementToken: token, maxElevation: startElevation }) : startElevation;

  // Adjust the destination for terrain setElevation regions.
  const api = MODULES_ACTIVE.API.TERRAIN_MAPPER;
  if ( !api || !api.estimateElevationForSegment ) return endElevation;
  const segments = api.estimateElevationForSegment(prevWaypoint, location, { startElevation, endElevation });
  if ( !segments.length ) return endElevation;
  const elevationTM = segments.at(-1).elevation;
  return isFinite(elevationTM) ? elevationTM : endElevation;
}

// ----- NOTE: HELPER FUNCTIONS ----- //

function retrieveVisibleTokens() {
  return canvas.tokens.children[0].children.filter(c => c.visible);
}

// ----- NOTE: TerrainMapper Elevation ----- //

/**
 * Measure the terrain elevation at a given point using Terrain Mapper
 * @param {Point} location                Point to measure, in {x, y} format
 * @param {object} [opts]     Options that limit the regions to test; passed to TM's regionElevationAtPoint
 * @param {number} [opts.fixedElevation]      Any region that contains this elevation counts
 * @param {number} [opts.maxElevation]        Any region below or equal to this grid elevation counts
 * @param {number} [opts.minElevation]        Any region above or equal to this grid elevation counts
 * @returns {Number|undefined} Point elevation or null if module not active or no region at location.
 */
function TMElevationAtPoint(location, opts) {
  const api = MODULES_ACTIVE.API.TERRAIN_MAPPER
  if ( !api || !api.regionElevationAtPoint ) return undefined;
  const res = api.regionElevationAtPoint(location, opts);
  if ( isFinite(res) ) return res;
  return canvas.scene.flags?.terrainmapper?.backgroundElevation;
}

// ----- NOTE: LEVELS ELEVATION ----- //
// use cases:
// generally:
// - if over a level-enabled object, use the bottom of that level.
// - if multiple, use the closest to the starting elevation
// starting point of the ruler is a token:
// - if the same level is present, stay at that level
//   (elevation should be found from the token, so no issue)

/*
 * Measure the elevation of any levels tiles at the point.
 * If the point is within a hole, return the bottom of that hole.
 * If the point is within a level, return the bottom of the level.
 * @param {PIXI.Point} p    Point to measure, in {x, y} format.
 * @return {Number|undefined} Levels elevation or undefined if levels is inactive or no levels found.
 */
export function LevelsElevationAtPoint(p, startingElevation = 0) {
  if ( !MODULES_ACTIVE.LEVELS ) return undefined;

  let tiles = [...levelsTilesAtPoint(p)];
  if ( !tiles.length ) return null;

  tiles = tiles
    .filter(t => startingElevation >= t.document.flags.levels.rangeBottom
      && startingElevation < t.document.flags.levels.rangeTop)
    .sort((a, b) => a.document.flags.levels.rangeBottom - b.document.flags.levels.rangeBottom);

  const ln = tiles.length;
  if ( !ln ) return undefined;
  return tiles[ln - 1].document.flags.levels.rangeBottom;
}


/**
 * Get all tiles that have a levels range
 * @param {Point} {x, y}
 * @returns {Set<Tile>}
 */
function levelsTilesAtPoint({x, y}) {
  const bounds = new PIXI.Rectangle(x, y, 1, 1);
  const collisionTest = (o, rect) => { // eslint-disable-line no-unused-vars
    // The object o constains n (Quadtree node), r (rect), t (object to test)
    const flags = o.t.document?.flags?.levels;
    if ( !flags ) return false;
    if ( !isFinite(flags.rangeTop) || !isFinite(flags.rangeBottom) ) return false;
    return true;
  };

  return canvas.tiles.quadtree.getObjects(bounds, { collisionTest });
}

/** All HTTP route installers beyond the core (/healthz, metadata, /mcp). */
import type { Express } from 'express';
import type { AppContext } from './app.js';
import type { GatewayCore } from './gateway.js';

export type RouteInstaller = (app: Express, ctx: AppContext, gw: GatewayCore) => void;

export function installAllRoutes(): RouteInstaller[] {
  return [];
}
